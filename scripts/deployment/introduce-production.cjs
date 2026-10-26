"use strict";
const { verifyCollectorRequest } = require("./collector-command.cjs");
const assert = require("node:assert/strict");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const {
  parseProductionManifest,
  parsePhaseAuthorization,
  phases,
} = require("./production-manifest.cjs");
const {
  awsCaller,
  manifestHash,
  readArguments,
} = require("./sandbox-manifest.cjs");
const { createAwsCaller } = require("./coordinator-aws.cjs");
const {
  createEvidenceCollector,
  stateDigest,
} = require("./production-evidence.cjs");
const { buildMaintenancePolicy } = require("./maintenance-fence.cjs");
const {
  initialControl,
  assertPreparedCandidate,
  assertTargetGroups,
} = require("./bootstrap-core.cjs");
const { listServiceTaskArns } = require("./service-task-inventory.cjs");
const { action } = require("./routing.cjs");
const key = (sk) => marshall({ pk: "ENV", sk });
const financialFlags = [
  "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
  "STRIPE_RENEWAL_GRACE_ENABLED",
  "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
  "STRIPE_RENEWAL_REACTIVATION_ENABLED",
];
function receiptProof(proof) {
  const rounds = proof.rounds ?? [proof];
  return {
    captures: rounds.map((round) => ({
      capture: round.capture,
      stateSha256: round.stateSha256,
      validUntil: round.proof.validUntil,
      observedAt: round.proof.observedAt,
    })),
  };
}
function ready(condition, message) {
  if (!condition) {
    const error = new Error(message);
    error.code = "candidate_not_ready";
    throw error;
  }
}
function bootstrapBinding(m) {
  return {
    ...m,
    operationId: m.binding.operationId,
    imageDigest: m.binding.candidateDigest,
  };
}
function createIntroductionEngine(m, ports) {
  const now = ports.now ?? (() => Math.floor(Date.now() / 1000));
  const hash = ports.expectedSha256,
    diagnostic = {};
  const aws =
    ports.aws ?? createAwsCaller(awsCaller(m.binding.region), diagnostic);
  const table = m.controlTableArn,
    headKey = "PRODUCTION_INTRODUCTION";
  const evidence = createEvidenceCollector({
    m,
    aws,
    probe: ports.probe,
    now,
    manifestSha256: hash,
  });
  let authorization,
    head,
    firstAppend,
    target = "primary";
  const selected = () =>
    target === "primary"
      ? {
          taskDefinition: m.taskDefinition,
          sourceSha: m.binding.sourceSha,
          digest: m.binding.candidateDigest,
        }
      : {
          taskDefinition: m.fallbackTaskDefinition,
          sourceSha: m.fallbackSourceSha,
          digest: m.fallbackDigest,
        };
  async function read(sk) {
    const result = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: key(sk),
      ConsistentRead: true,
    });
    return result.Item ? unmarshall(result.Item) : null;
  }
  function authority() {
    assert.ok(
      now() < m.validUntil && now() < authorization.validUntil,
      "Operation authority expired; preserve fence",
    );
  }
  async function identity() {
    authority();
    const caller = await aws("sts", "get-caller-identity", {});
    assert.equal(caller.Account, m.binding.accountId);
    assert.equal(
      caller.Arn,
      authorization.principalArn,
      "Wrong execution session",
    );
    authority();
  }
  async function readHead() {
    const value = await read(headKey);
    if (value) {
      assert.equal(value.operationId, m.binding.operationId);
      assert.equal(value.manifestSha256, hash);
      const receipt = await read(value.receiptKey);
      assert.ok(receipt);
      const body = JSON.parse(receipt.bodyJson);
      assert.ok(["primary", "fallback"].includes(body.target));
      target = body.target;
      assert.equal(body.stage, value.stage, "Receipt stage changed");
      assert.equal(body.operationId, m.binding.operationId);
      assert.equal(body.manifestSha256, hash);
      assert.equal(
        value.receiptKey,
        "PRODUCTION_INTRODUCTION#" +
          m.binding.operationId +
          "#" +
          value.receiptSha256,
      );
      assert.equal(
        manifestHash(JSON.parse(receipt.bodyJson)),
        value.receiptSha256,
        "Receipt changed",
      );
    }
    return value;
  }
  function currentProof(proof) {
    for (const round of proof.rounds ?? [proof]) {
      const observation = round.proof,
        request = observation.request;
      assert.equal(request.operationId, m.binding.operationId);
      assert.equal(request.manifestSha256, hash);
      assert.equal(request.roleArn, m.binding.taskRoleArn);
      verifyCollectorRequest(m, request);
      assert.deepEqual(request.compatibilityTarget, selected());
      assert.ok(
        observation.observedAt <= now() &&
          now() - observation.observedAt <= m.observationMaxAgeSeconds &&
          observation.validUntil > now(),
        "Action evidence expired",
      );
    }
    authority();
    if (authorization.phase === "drain")
      assert.ok(now() < m.drainDeadline, "Drain deadline expired");
    if (authorization.phase === "activate")
      assert.ok(now() < m.warmupDeadline, "Warmup deadline expired");
  }
  async function append(
    stage,
    proof,
    buildTransactions = () => [],
    providerRequest,
  ) {
    await identity();
    currentProof(proof);
    const predecessorSha256 = head?.receiptSha256 ?? null;
    const body = {
      target,
      operationId: m.binding.operationId,
      manifestSha256: hash,
      predecessorSha256,
      stage,
      phase: authorization.phase,
      authorizationSha256: manifestHash(authorization),
      principalArn: authorization.principalArn,
      recordedAt: now(),
      proof: receiptProof(proof),
      ...(providerRequest ? { providerRequest } : {}),
    };
    assert.ok(
      Buffer.byteLength(JSON.stringify(body)) <= 16384,
      "Oversized operation receipt",
    );
    const receiptSha256 = manifestHash(body),
      receiptKey =
        "PRODUCTION_INTRODUCTION#" +
        m.binding.operationId +
        "#" +
        receiptSha256;
    const next = {
      pk: "ENV",
      sk: headKey,
      operationId: m.binding.operationId,
      manifestSha256: hash,
      stage,
      receiptSha256,
      receiptKey,
    };
    const condition = head
      ? {
          ConditionExpression:
            "operationId = :op AND manifestSha256 = :manifest AND receiptSha256 = :prior",
          ExpressionAttributeValues: marshall({
            ":op": m.binding.operationId,
            ":manifest": hash,
            ":prior": predecessorSha256,
          }),
        }
      : { ConditionExpression: "attribute_not_exists(pk)" };
    const items = [
      { Put: { TableName: table, Item: marshall(next), ...condition } },
      {
        Put: {
          TableName: table,
          Item: marshall({
            pk: "ENV",
            sk: receiptKey,
            bodyJson: JSON.stringify(body),
          }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ];
    if (firstAppend)
      items.push({
        Put: {
          TableName: table,
          Item: marshall({
            pk: "ENV",
            sk: "PRODUCTION_INVOCATION#" + authorization.runId,
            operationId: m.binding.operationId,
            authorizationSha256: manifestHash(authorization),
          }),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    const transactions = buildTransactions();
    if (transactions.length)
      await aws("dynamodb", "transact-write-items", {
        TransactItems: [
          ...transactions,
          {
            ConditionCheck: {
              TableName: table,
              Key: key(headKey),
              ConditionExpression:
                "operationId = :op AND manifestSha256 = :manifest AND receiptSha256 = :prior",
              ExpressionAttributeValues: marshall({
                ":op": m.binding.operationId,
                ":manifest": hash,
                ":prior": predecessorSha256,
              }),
            },
          },
        ],
      });
    currentProof(proof);
    await aws("dynamodb", "transact-write-items", { TransactItems: items });
    head = next;
    firstAppend = false;
    return next;
  }
  function context(owned, extra = {}) {
    return {
      phase: authorization.phase,
      compatibilityTarget: selected(),
      predecessorSha256: head?.receiptSha256 ?? null,
      taskArn: m.legacyTaskArn,
      taskDefinition: m.legacyTaskDefinition,
      sourceSha: m.binding.legacySha,
      owned,
      ...extra,
    };
  }
  async function service() {
    const response = await aws("ecs", "describe-services", {
      cluster: m.cluster,
      services: [m.service],
    });
    assert.equal(response.failures?.length ?? 0, 0);
    assert.equal(response.services.length, 1);
    const svc = response.services[0];
    assert.equal(svc.serviceName, m.service);
    assert.deepEqual(svc.loadBalancers, [
      {
        targetGroupArn: m.targetGroupA,
        containerName: m.containerName,
        containerPort: m.containerPort,
      },
    ]);
    return svc;
  }
  async function tasks() {
    const arns = await listServiceTaskArns(aws, m),
      all = [];
    for (let i = 0; i < arns.length; i += 100) {
      const batch = arns.slice(i, i + 100),
        result = await aws("ecs", "describe-tasks", {
          cluster: m.cluster,
          tasks: batch,
        });
      assert.equal(result.failures?.length ?? 0, 0);
      assert.equal(result.tasks.length, batch.length);
      assert.deepEqual(
        result.tasks.map((t) => t.taskArn).sort(),
        [...batch].sort(),
      );
      all.push(...result.tasks);
    }
    return all;
  }
  async function legacyRunning() {
    const svc = await service();
    assert.equal(svc.taskDefinition, m.legacyTaskDefinition);
    assert.equal(svc.desiredCount, 1);
    assert.equal(svc.runningCount, 1);
    assert.equal(svc.pendingCount, 0);
    const live = (await tasks()).filter((t) => t.lastStatus !== "STOPPED");
    assert.equal(live.length, 1);
    assert.equal(live[0].taskArn, m.legacyTaskArn);
    assert.equal(live[0].taskDefinitionArn, m.legacyTaskDefinition);
    return svc;
  }
  async function stopped() {
    const svc = await service();
    assert.equal(svc.taskDefinition, m.legacyTaskDefinition);
    for (const k of ["desiredCount", "runningCount", "pendingCount"])
      assert.equal(svc[k], 0, "Old service not settled");
    const all = await tasks();
    assert.ok(all.every((t) => t.lastStatus === "STOPPED"));
    const legacy = await aws("ecs", "describe-tasks", {
      cluster: m.cluster,
      tasks: [m.legacyTaskArn],
    });
    assert.equal(legacy.failures?.length ?? 0, 0);
    assert.equal(legacy.tasks.length, 1);
    assert.equal(legacy.tasks[0].taskArn, m.legacyTaskArn);
    assert.equal(legacy.tasks[0].taskDefinitionArn, m.legacyTaskDefinition);
    assert.equal(legacy.tasks[0].lastStatus, "STOPPED");
  }
  async function candidateDefinition() {
    const result = await aws("ecs", "describe-task-definition", {
        taskDefinition: selected().taskDefinition,
      }),
      d = result.taskDefinition;
    assertPreparedCandidate(
      {
        ...bootstrapBinding(m),
        taskDefinition: selected().taskDefinition,
        imageDigest: selected().digest,
      },
      d,
    );
    assert.equal(d.taskRoleArn, m.binding.taskRoleArn);
    assert.equal(d.executionRoleArn, m.executionRoleArn);
    const container = d.containerDefinitions.find(
      (c) => c.name === m.containerName,
    );
    for (const flag of financialFlags) {
      assert.ok(!container.secrets?.some((s) => s.name === flag));
      const values = container.environment.filter((e) => e.name === flag);
      assert.equal(values.length, 1);
      assert.equal(values[0].value, "false");
    }
    const repository = `${m.binding.accountId}.dkr.ecr.${m.binding.region}.amazonaws.com/${m.imageRepository}`;
    assert.equal(container.image, repository + "@" + selected().digest);
    const images = await aws("ecr", "describe-images", {
      registryId: m.binding.accountId,
      repositoryName: m.imageRepository,
      imageIds: [{ imageTag: selected().sourceSha }],
    });
    assert.equal(images.imageDetails.length, 1);
    assert.equal(images.imageDetails[0].imageDigest, selected().digest);
  }
  async function step(name, before, operation, after) {
    const proof = await before();
    await append(name + "_submitted", proof);
    await identity();
    currentProof(proof);
    await operation();
    const result = await after();
    await append(name + "_acknowledged", result);
    return result;
  }
  async function fence() {
    assert.equal(head, null, "Fence cannot be replayed");
    assert.equal(
      await read("CONTROL"),
      null,
      "Existing Control cannot be adopted",
    );
    await candidateDefinition();
    const svc = await legacyRunning();
    assert.equal(stateDigest(svc), m.originalServiceSha256);
    await step(
      "fence",
      () => evidence.round(context(false)),
      () =>
        aws("iam", "put-role-policy", {
          RoleName: m.binding.taskRoleArn.split("/").at(-1),
          PolicyName: m.ownedPolicyName,
          PolicyDocument: JSON.stringify(buildMaintenancePolicy(m.binding)),
        }),
      () => evidence.round(context(true)),
    );
  }
  async function drain() {
    assert.equal(head?.stage, "fence_acknowledged");
    assert.ok(now() < m.drainDeadline, "Drain deadline expired");
    await legacyRunning();
    const proof = await evidence.drain(context(true));
    await append("drained", proof);
  }
  async function abort() {
    assert.ok(
      ["fence_acknowledged", "drained"].includes(head?.stage),
      "Abort only before shutdown submission",
    );
    const svc = await legacyRunning();
    assert.equal(stateDigest(svc), m.originalServiceSha256);
    await step(
      "abort",
      () => evidence.round(context(true)),
      () =>
        aws("iam", "delete-role-policy", {
          RoleName: m.binding.taskRoleArn.split("/").at(-1),
          PolicyName: m.ownedPolicyName,
        }),
      () => evidence.round(context(false)),
    );
  }
  async function listener() {
    const response = await aws("elbv2", "describe-listeners", {
      ListenerArns: [m.listenerArn],
    });
    assert.equal(response.Listeners.length, 1);
    assert.equal(response.Listeners[0].ListenerArn, m.listenerArn);
    return response.Listeners[0];
  }
  async function route(priorCapture) {
    const old = await listener();
    assert.equal(stateDigest(old.DefaultActions), m.originalRoutingSha256);
    await assertTargetGroups(bootstrapBinding(m), aws, old, true);
    const desired = action(
      { sourceGroup: m.targetGroupA, candidateGroup: m.targetGroupB },
      false,
    );
    const ctx = context(true, { stopped: true, priorCapture });
    await step(
      "routing",
      () => evidence.drain(ctx),
      () =>
        aws("elbv2", "modify-listener", {
          ListenerArn: m.listenerArn,
          DefaultActions: desired,
        }),
      async () => {
        assert.deepEqual((await listener()).DefaultActions, desired);
        return evidence.drain(ctx);
      },
    );
  }
  async function initialize(priorCapture) {
    await stopped();
    assert.equal(
      await read("CONTROL"),
      null,
      "Existing Control cannot be adopted",
    );
    const proof = await evidence.drain(
      context(true, { stopped: true, priorCapture }),
    );
    await append("initialize_submitted", proof);
    const types =
      ports.types ?? require("../../dist/types/deploymentControl.js");
    const control = types.controlRecordSchema.parse(
      initialControl(m.binding.operationId, m.validUntil),
    );
    await append("initialize_acknowledged", proof, () => [
      {
        Put: {
          TableName: table,
          Item: marshall(control),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ]);
  }
  async function candidateState() {
    const svc = await service();
    assert.equal(svc.taskDefinition, selected().taskDefinition);
    assert.deepEqual(svc.deploymentController, { type: "ECS" });
    assert.deepEqual(
      svc.deploymentConfiguration,
      m.targetDeploymentConfiguration,
    );
    assert.equal(svc.desiredCount, 1);
    ready(
      svc.runningCount === 1 && svc.pendingCount === 0,
      "Candidate is starting",
    );
    const live = (await tasks()).filter((t) => t.lastStatus !== "STOPPED");
    ready(live.length === 1, "Candidate task unavailable");
    const task = live[0];
    assert.equal(task.taskDefinitionArn, selected().taskDefinition);
    assert.equal(task.lastStatus, "RUNNING");
    const container = task.containers.find((c) => c.name === m.containerName);
    assert.equal(container.imageDigest, selected().digest);
    assert.equal(container.networkInterfaces.length, 1);
    const health = await aws("elbv2", "describe-target-health", {
      TargetGroupArn: m.targetGroupA,
    });
    assert.equal(health.TargetHealthDescriptions.length, 1);
    const target = health.TargetHealthDescriptions[0];
    assert.equal(
      target.Target.Id,
      container.networkInterfaces[0].privateIpv4Address,
    );
    assert.equal(target.Target.Port, m.containerPort);
    ready(target.TargetHealth.State === "healthy", "Candidate target warming");
    const protection = await aws("ecs", "get-task-protection", {
      cluster: m.cluster,
      tasks: [task.taskArn],
    });
    assert.equal(protection.failures?.length ?? 0, 0);
    assert.equal(protection.protectedTasks.length, 1);
    const protectedTask = protection.protectedTasks[0];
    assert.equal(protectedTask.taskArn, task.taskArn);
    assert.equal(protectedTask.protectionEnabled, true);
    assert.ok(Date.parse(protectedTask.expirationDate) / 1000 > now() + 120);
    assert.deepEqual(
      (await listener()).DefaultActions,
      action(
        { sourceGroup: m.targetGroupA, candidateGroup: m.targetGroupB },
        false,
      ),
    );
    await candidateDefinition();
    return {
      task,
      protectionValidUntil:
        Date.parse(protectedTask.expirationDate) / 1000 - 120,
    };
  }
  async function runtimeFor(task, role, owned) {
    const rows = [];
    let cursor;
    do {
      const page = await aws("dynamodb", "scan", {
        TableName: table,
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      });
      rows.push(...page.Items.map(unmarshall));
      assert.ok(rows.length <= 1000);
      cursor = page.LastEvaluatedKey;
    } while (cursor && Object.keys(cursor).length);
    const matching = rows.filter(
      (r) => r.recordType === "runtime" && r.identity?.taskArn === task.taskArn,
    );
    ready(matching.length > 0, "Candidate registration pending");
    assert.equal(matching.length, 1, "Candidate registration ambiguous");
    const types =
      ports.types ?? require("../../dist/types/deploymentControl.js");
    const row = types.runtimeRecordSchema.parse(matching[0]);
    assert.equal(row.role, role);
    assert.equal(row.identity.kind, "ecs");
    assert.equal(row.identity.candidateId, m.binding.operationId);
    assert.equal(row.identity.imageDigest, selected().digest);
    assert.equal(row.retirementRequest, undefined);
    assert.equal(row.retirementAcknowledgment, undefined);
    if (role === "candidate" || owned)
      assert.ok(
        row.workCounts && Object.values(row.workCounts).every((v) => v === 0),
      );
    assert.equal(row.readiness.runtimeMode, m.runtimeMode);
    assert.equal(row.readiness.observedEpoch, 1);
    assert.equal(
      row.readiness.observedGeneration,
      role === "candidate" ? 0 : 1,
    );
    assert.ok(
      row.readiness.provenAt <= now() && row.readiness.expiresAt > now(),
    );
    assert.ok(
      row.protection.provenAt <= now() &&
        row.protection.expiresAt > now() + 120,
    );
    for (const field of ["cacheReady", "dependenciesReady"])
      ready(row.readiness[field], `Candidate ${field} warming`);
    if (m.runtimeMode !== "api")
      ready(row.readiness.gatewayReady, "Candidate gateway warming");
    return row;
  }
  async function candidateProof(owned, role = "candidate") {
    const { task, protectionValidUntil } = await candidateState(),
      row = await runtimeFor(task, role, owned);
    const proof = await evidence.round(
      context(owned, {
        taskArn: task.taskArn,
        taskDefinition: selected().taskDefinition,
        sourceSha: selected().sourceSha,
        validUntil: Math.min(
          protectionValidUntil,
          row.readiness.expiresAt,
          row.protection.expiresAt - 120,
        ),
      }),
    );
    return { proof, row };
  }
  async function launch(priorCapture) {
    await stopped();
    await candidateDefinition();
    const proof = await evidence.drain(
      context(true, { stopped: true, priorCapture }),
    );
    await append("launch_submitted", proof);
    await identity();
    currentProof(proof);
    await aws("ecs", "update-service", {
      cluster: m.cluster,
      service: m.service,
      taskDefinition: selected().taskDefinition,
      desiredCount: 1,
      deploymentConfiguration: m.targetDeploymentConfiguration,
    });
    await append("launch_acknowledged", proof);
    const candidate = await waitForCandidate(priorCapture);
    await append("candidate_ready", candidate.proof);
    return candidate;
  }
  async function waitForCandidate(priorCapture) {
    while (now() < m.warmupDeadline) {
      await identity();
      if (await recordKnownFailure(priorCapture))
        throw new Error(
          "Known candidate startup failure; approved fallback recovery required",
        );
      try {
        return await candidateProof(true);
      } catch (error) {
        if (error.code !== "candidate_not_ready") throw error;
      }
      await (
        ports.pause ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(1000);
    }
    throw new Error("Candidate warmup deadline expired; preserve fence");
  }
  async function waitForStopped() {
    while (now() < m.drainDeadline) {
      await identity();
      const svc = await service();
      assert.equal(svc.taskDefinition, m.legacyTaskDefinition);
      if (
        svc.desiredCount === 0 &&
        svc.runningCount === 0 &&
        svc.pendingCount === 0
      )
        return stopped();
      await (
        ports.pause ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
      )(1000);
    }
    throw new Error("Legacy settlement deadline expired; preserve fence");
  }
  async function promote(candidate) {
    const fresh = await candidateProof(true);
    assert.deepEqual(fresh.row.identity, candidate.row.identity);
    const builders =
      ports.builders ??
      require("../../dist/services/deploymentControlTransactions.js");
    await append("promotion_submitted", fresh.proof);
    await append(
      "promotion_acknowledged",
      fresh.proof,
      () =>
        builders.buildPromotionTransaction({
          tables: { deploymentControl: table },
          coordinatorToken: m.binding.operationId,
          coordinatorEpoch: 1,
          expectedServingGeneration: 0,
          expectedServingMembers: [],
          proposedGeneration: 1,
          candidate: fresh.row.identity,
          candidateRuntimeMode: m.runtimeMode,
          now: now(),
        }).TransactItems,
    );
  }
  async function failureProof(priorCapture) {
    const svc = await service();
    assert.equal(svc.taskDefinition, selected().taskDefinition);
    assert.equal(svc.runningCount, 0);
    assert.equal(svc.pendingCount, 0);
    assert.deepEqual(svc.deploymentController, { type: "ECS" });
    assert.deepEqual(
      svc.deploymentConfiguration,
      m.targetDeploymentConfiguration,
    );
    assert.equal(svc.deployments.length, 1);
    const deployment = svc.deployments[0];
    assert.equal(deployment.taskDefinition, selected().taskDefinition);
    assert.equal(deployment.status, "PRIMARY");
    assert.equal(deployment.rolloutState, "FAILED");
    assert.ok(deployment.id);
    const all = await tasks();
    assert.ok(all.every((t) => t.lastStatus === "STOPPED"));
    const failed = all.filter(
      (t) => t.taskDefinitionArn === selected().taskDefinition,
    );
    assert.equal(failed.length, 1);
    const ctl = await read("CONTROL");
    assert.equal(ctl.coordinatorToken, m.binding.operationId);
    assert.equal(ctl.servingGeneration, 0);
    assert.deepEqual(ctl.servingMembers, {});
    return evidence.drain(
      context(true, {
        failedCandidate: true,
        priorCapture,
        taskArn: failed[0].taskArn,
        taskDefinition: selected().taskDefinition,
        sourceSha: selected().sourceSha,
      }),
    );
  }
  async function recordKnownFailure(priorCapture) {
    const svc = await service();
    if (!svc.deployments?.some((d) => d.rolloutState === "FAILED"))
      return false;
    const proof = await failureProof(priorCapture);
    await append("candidate_failed", proof);
    return true;
  }
  async function recoveryCapture() {
    assert.ok(authorization.recovery, "Explicit recovery authority required");
    assert.equal(
      authorization.recovery.submittedReceiptSha256,
      head.receiptSha256,
    );
    const receipt = JSON.parse((await read(head.receiptKey)).bodyJson),
      references = receipt.proof.captures;
    const reference = references.at(-1).capture;
    assert.equal(reference.sha256, authorization.recovery.evidenceSha256);
    const retained = await evidence.readRetained(reference);
    assert.equal(retained.proof.request.operationId, m.binding.operationId);
    assert.equal(retained.proof.request.manifestSha256, hash);
    return retained;
  }
  async function fallback() {
    assert.equal(head.stage, "candidate_failed");
    assert.equal(target, "primary", "Fallback is not repeatable");
    const prior = await recoveryCapture();
    await failureProof(prior.handoffCapture);
    target = "fallback";
    await candidateDefinition();
    const proof = await evidence.drain(
      context(true, {
        failedCandidate: true,
        priorCapture: prior.handoffCapture,
        taskArn: prior.proof.request.taskArn,
        taskDefinition: m.taskDefinition,
        sourceSha: m.binding.sourceSha,
      }),
    );
    const request = {
      cluster: m.cluster,
      service: m.service,
      taskDefinition: m.fallbackTaskDefinition,
      desiredCount: 1,
      deploymentConfiguration: m.targetDeploymentConfiguration,
      ...(m.fallbackTaskDefinition === m.taskDefinition
        ? { forceNewDeployment: true }
        : {}),
    };
    await append("fallback_submitted", proof, undefined, {
      service: "ecs",
      operation: "update-service",
      input: request,
    });
    await identity();
    currentProof(proof);
    await aws("ecs", "update-service", request);
    await append("fallback_acknowledged", proof);
    const candidate = await waitForCandidate(prior.handoffCapture);
    await promote(candidate);
  }
  async function activate() {
    if (authorization.recovery) return fallback();
    assert.equal(head?.stage, "drained", "Activation cannot replay");
    await legacyRunning();
    await candidateDefinition();
    const before = await evidence.drain(context(true)),
      priorCapture = before.rounds[1].capture;
    await append("shutdown_submitted", before);
    await identity();
    currentProof(before);
    assert.ok(now() < m.drainDeadline, "Drain deadline expired");
    await aws("ecs", "update-service", {
      cluster: m.cluster,
      service: m.service,
      desiredCount: 0,
    });
    await waitForStopped();
    const after = await evidence.drain(
      context(true, { stopped: true, priorCapture }),
    );
    await append("shutdown_acknowledged", after);
    await route(priorCapture);
    await initialize(priorCapture);
    const candidate = await launch(priorCapture);
    await promote(candidate);
  }
  async function complete() {
    assert.equal(head?.stage, "promotion_acknowledged");
    await step(
      "removal",
      async () => (await candidateProof(true, "serving")).proof,
      () =>
        aws("iam", "delete-role-policy", {
          RoleName: m.binding.taskRoleArn.split("/").at(-1),
          PolicyName: m.ownedPolicyName,
        }),
      async () => (await candidateProof(false, "serving")).proof,
    );
    const final = await candidateProof(false, "serving");
    const control = await read("CONTROL");
    assert.equal(control.coordinatorToken, m.binding.operationId);
    assert.equal(control.servingGeneration, 1);
    assert.deepEqual(control.servingMembers, {
      [final.row.identity.instanceId]: final.row.identity,
    });
    await append("restoration_submitted", final.proof);
    await append("complete", final.proof, () => [
      {
        Update: {
          TableName: table,
          Key: key("CONTROL"),
          ConditionExpression:
            "coordinatorToken = :op AND coordinatorEpoch = :epoch AND servingGeneration = :generation AND servingMembers = :members",
          UpdateExpression: "SET coordinatorExpiresAt = :released",
          ExpressionAttributeValues: marshall({
            ":op": m.binding.operationId,
            ":epoch": 1,
            ":generation": 1,
            ":members": control.servingMembers,
            ":released": 0,
          }),
        },
      },
    ]);
  }
  async function inspect() {
    const caller = await aws("sts", "get-caller-identity", {});
    assert.equal(caller.Account, m.binding.accountId);
    const roleName = m.deploymentRoleArn.split("/").at(-1);
    assert.ok(
      caller.Arn.startsWith(
        `arn:aws:sts::${m.binding.accountId}:assumed-role/${roleName}/`,
      ),
    );
    return {
      kind: "inspection",
      head: await readHead(),
      service: await service(),
      tasks: await tasks(),
      collectorAvailable: Boolean(ports.probe),
    };
  }
  async function run(phase, validatedAuthorization) {
    assert.ok(phases.includes(phase), "Unknown phase");
    if (phase === "inspect") return inspect();
    assert.ok(ports.probe, "Trusted evidence collector unavailable");
    authorization = validatedAuthorization;
    assert.ok(authorization, "Validated phase authorization required");
    assert.equal(authorization.phase, phase);
    await identity();
    head = await readHead();
    assert.equal(
      authorization.predecessorSha256,
      head?.receiptSha256 ?? null,
      "Stale approved predecessor",
    );
    firstAppend = true;
    if (phase === "reconcile") {
      await recoveryCapture();
      return { kind: "reconciliation_required", head, providerMutation: false };
    }
    assert.ok(
      !head?.stage.endsWith("_submitted"),
      "Unknown acknowledgment requires read-only reconciliation",
    );
    const handlers = { fence, drain, abort, activate, complete };
    assert.ok(handlers[phase], "Lifecycle phase not implemented");
    await handlers[phase]();
    return { kind: head.stage, receiptSha256: head.receiptSha256 };
  }
  return { run };
}
function createProductionIntroduction(options) {
  const manifest = parseProductionManifest(
    options.manifest,
    options.expectedSha256,
  );
  const engine = createIntroductionEngine(manifest, options);
  return {
    async run(phase) {
      assert.ok(phases.includes(phase), "Unknown phase");
      const authorization =
        phase === "inspect" || !options.probe
          ? undefined
          : parsePhaseAuthorization(
              options.authorization,
              manifest,
              options.expectedSha256,
            );
      return engine.run(phase, authorization);
    },
  };
}
async function runCli(args = process.argv.slice(2), output = console) {
  try {
    const [phase, ...rest] = args;
    const options = readArguments(rest);
    const result = await createProductionIntroduction(options).run(phase);
    output.log(JSON.stringify(result));
    return 0;
  } catch {
    output.error(
      JSON.stringify({
        kind: "production_introduction_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    return 1;
  }
}
module.exports = {
  createProductionIntroduction,
  createIntroductionEngine,
  runCli,
};
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
