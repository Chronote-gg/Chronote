#!/usr/bin/env node
"use strict";
const { sameEcsTaskArn } = require("../../src/utils/ecsTaskArn.js");
const { isDeepStrictEqual: same } = require("node:util");
const { randomUUID } = require("node:crypto");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { listServiceTaskArns } = require("./service-task-inventory.cjs");
const {
  parseManifest,
  awsCaller,
  readArguments,
} = require("./sandbox-manifest.cjs");
const {
  assertPreparedCandidate,
  assertTargetGroups,
  initialControl,
} = require("./bootstrap-core.cjs");
function createBootstrap(options) {
  // A caller-built binding (the production cold cutover) skips the Sandbox manifest schema.
  const m =
    options.binding ?? parseManifest(options.manifest, options.expectedSha256);
  const aws = options.aws ?? awsCaller(m.region);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const builders =
    options.builders ??
    require("../../dist/services/deploymentControlTransactions.js");
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  const table = m.tablePrefix + "DeploymentControlTable";
  const key = (sk) => marshall({ pk: "ENV", sk });
  const receiptKey = "BOOTSTRAP#" + m.operationId;
  const fail = (message) => {
    throw new Error(message);
  };
  async function read(sk) {
    const r = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: key(sk),
      ConsistentRead: true,
    });
    return r.Item ? unmarshall(r.Item) : undefined;
  }
  async function identity() {
    const r = await aws("sts", "get-caller-identity", {});
    if (r.Account !== m.accountId || r.Arn !== m.principalArn)
      fail("Execution identity mismatch");
  }
  async function service() {
    const r = await aws("ecs", "describe-services", {
      cluster: m.cluster,
      services: [m.service],
    });
    if (
      r.failures?.length ||
      r.services?.length !== 1 ||
      r.services[0].serviceName !== m.service
    )
      fail("Service identity unavailable");
    const svc = r.services[0];
    if (
      !same(svc.loadBalancers, [
        {
          targetGroupArn: m.targetGroupA,
          containerName: m.containerName,
          containerPort: m.containerPort,
        },
      ])
    )
      fail("Service binding mismatch");
    return svc;
  }
  async function tasks() {
    const result = [];
    const all = await listServiceTaskArns(aws, m);
    for (let i = 0; i < all.length; i += 100) {
      const r = await aws("ecs", "describe-tasks", {
        cluster: m.cluster,
        tasks: all.slice(i, i + 100),
      });
      if (r.failures?.length || r.tasks.length !== all.slice(i, i + 100).length)
        fail("Task inventory incomplete");
      result.push(...r.tasks.filter((t) => t.lastStatus !== "STOPPED"));
    }
    return result;
  }
  async function scan(TableName, ProjectionExpression) {
    const rows = [];
    let ExclusiveStartKey;
    do {
      const fields = ProjectionExpression.split(",").map((v) => v.trim());
      const r = await aws("dynamodb", "scan", {
        TableName,
        ConsistentRead: true,
        ProjectionExpression: fields.map((_, i) => `#f${i}`).join(","),
        ExpressionAttributeNames: Object.fromEntries(
          fields.map((v, i) => [`#f${i}`, v]),
        ),
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      rows.push(...(r.Items ?? []).map(unmarshall));
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
  }
  async function topology(requireEmpty) {
    const l = await aws("elbv2", "describe-listeners", {
      ListenerArns: [m.listenerArn],
    });
    const listener = l.Listeners?.[0];
    const expected = [
      {
        Type: "forward",
        ForwardConfig: {
          TargetGroups: [
            { TargetGroupArn: m.targetGroupA, Weight: 100 },
            { TargetGroupArn: m.targetGroupB, Weight: 0 },
          ],
          TargetGroupStickinessConfig: { Enabled: false },
        },
      },
    ];
    const actions = JSON.parse(JSON.stringify(listener?.DefaultActions ?? []));
    for (const a of actions) {
      delete a.Order;
      if (a.ForwardConfig?.TargetGroupStickinessConfig?.Enabled === false)
        delete a.ForwardConfig.TargetGroupStickinessConfig.DurationSeconds;
      if (a.ForwardConfig)
        a.ForwardConfig.TargetGroups.sort((a, b) =>
          a.TargetGroupArn.localeCompare(b.TargetGroupArn),
        );
    }
    expected[0].ForwardConfig.TargetGroups.sort((a, b) =>
      a.TargetGroupArn.localeCompare(b.TargetGroupArn),
    );
    if (
      l.Listeners.length !== 1 ||
      listener.ListenerArn !== m.listenerArn ||
      listener.Protocol !== "HTTPS" ||
      !same(actions, expected)
    )
      fail("Weighted routing introduction is not confirmed");
    const rules = await aws("elbv2", "describe-rules", {
      ListenerArn: m.listenerArn,
    });
    if (
      rules.NextMarker ||
      rules.Rules.length !== 1 ||
      !rules.Rules[0].IsDefault
    )
      fail("Foreign listener rules");
    await assertTargetGroups(m, aws, listener);
    for (const group of [m.targetGroupA, m.targetGroupB]) {
      const health = await aws("elbv2", "describe-target-health", {
        TargetGroupArn: group,
      });
      if (
        (requireEmpty || group === m.targetGroupB) &&
        health.TargetHealthDescriptions.length
      )
        fail("Occupied target group");
    }
  }
  function owned(c, r) {
    return (
      c?.coordinatorToken === m.operationId &&
      c.coordinatorEpoch === 1 &&
      c.runtimeEnvironment === "ecs" &&
      c.protocolVersion === 1 &&
      !c.deployment &&
      r?.manifestSha256 === options.expectedSha256 &&
      r.operationId === m.operationId
    );
  }
  function live(c, r) {
    if (
      !owned(c, r) ||
      c.coordinatorExpiresAt <= now() ||
      c.servingGeneration !== 0 ||
      Object.keys(c.servingMembers).length
    )
      fail("Bootstrap ownership changed or expired");
  }
  function receiptUpdate(from, to, extra = {}) {
    return {
      Update: {
        TableName: table,
        Key: key(receiptKey),
        ConditionExpression: "#stage = :from AND manifestSha256 = :hash",
        UpdateExpression:
          "SET #stage = :to" +
          Object.keys(extra)
            .map((k, i) => `, #x${i} = :x${i}`)
            .join(""),
        ExpressionAttributeNames: {
          "#stage": "stage",
          ...Object.fromEntries(
            Object.keys(extra).map((k, i) => [`#x${i}`, k]),
          ),
        },
        ExpressionAttributeValues: marshall({
          ":from": from,
          ":to": to,
          ":hash": options.expectedSha256,
          ...Object.fromEntries(
            Object.values(extra).map((v, i) => [`:x${i}`, v]),
          ),
        }),
      },
    };
  }
  function controlCheck() {
    return {
      ConditionCheck: {
        TableName: table,
        Key: key("CONTROL"),
        ConditionExpression:
          "coordinatorToken = :token AND coordinatorEpoch = :epoch AND coordinatorExpiresAt > :now AND servingGeneration = :generation AND servingMembers = :members",
        ExpressionAttributeValues: marshall({
          ":token": m.operationId,
          ":epoch": 1,
          ":now": now(),
          ":generation": 0,
          ":members": {},
        }),
      },
    };
  }
  async function write(items, established) {
    try {
      await aws("dynamodb", "transact-write-items", { TransactItems: items });
    } catch {
      if (!(await established()))
        fail("Conditional mutation outcome is unresolved");
    }
  }
  async function state() {
    return Promise.all([read("CONTROL"), read(receiptKey)]);
  }
  async function assertLegacyRuntimeStopped(message) {
    const svc = await service();
    if (
      svc.desiredCount !== 0 ||
      svc.runningCount !== 0 ||
      svc.pendingCount !== 0 ||
      svc.taskDefinition !== m.legacyTaskDefinition ||
      (await tasks()).length
    )
      fail(message);
  }
  function assertMaintenanceProof() {
    if (
      now() - Date.parse(m.maintenance.confirmedAt) / 1000 > 900 ||
      Date.parse(m.maintenance.confirmedAt) / 1000 > now()
    )
      fail("Maintenance proof is stale");
  }
  async function assertSettledLeases() {
    const leases = await scan(
      m.tablePrefix + "ActiveMeetingTable",
      "guildId, status, leaseExpiresAt",
    );
    if (
      leases.some(
        (r) =>
          r.leaseExpiresAt >= now() ||
          !["complete", "cancelled"].includes(r.status),
      )
    )
      fail("Unsettled lease remains");
  }
  async function introductionReceipt() {
    const existing = await scan(table, "pk, sk");
    if (!existing.length) return undefined;
    if (
      existing.length !== 1 ||
      existing[0].pk !== "ENV" ||
      existing[0].sk !== "INTRODUCTION"
    )
      fail("Control table has existing ownership");
    const introduction = await read("INTRODUCTION");
    if (
      introduction.operationId !== m.operationId ||
      introduction.manifestSha256 !== options.expectedSha256 ||
      introduction.principalArn !== m.principalArn ||
      introduction.stage !== "routing_acknowledged"
    )
      fail("Introduction ownership is unconfirmed");
    return introduction;
  }
  function introductionConditions(introduction) {
    if (!introduction) return [];
    return [
      {
        ConditionCheck: {
          TableName: table,
          Key: key("INTRODUCTION"),
          ConditionExpression:
            "operationId = :op AND manifestSha256 = :hash AND principalArn = :principal AND #stage = :stage",
          ExpressionAttributeNames: { "#stage": "stage" },
          ExpressionAttributeValues: marshall({
            ":op": m.operationId,
            ":hash": options.expectedSha256,
            ":principal": m.principalArn,
            ":stage": "routing_acknowledged",
          }),
        },
      },
    ];
  }
  async function initialize() {
    await identity();
    const [current, prior] = await state();
    if (current || prior) {
      if (!owned(current, prior)) fail("Existing Control cannot be adopted");
      return { kind: "initialized", stage: prior.stage };
    }
    await assertLegacyRuntimeStopped("Legacy runtime is not stopped");
    if (options.attestSettled) await options.attestSettled();
    else {
      assertMaintenanceProof();
      await assertSettledLeases();
    }
    const introduction = await introductionReceipt();
    await topology(true);
    const ctl = types.controlRecordSchema.parse(
      initialControl(m.operationId, now() + 1800),
    );
    const receipt = {
      pk: "ENV",
      sk: receiptKey,
      operationId: m.operationId,
      manifestSha256: options.expectedSha256,
      stage: "initialized",
    };
    await write(
      [
        ...[ctl, receipt].map((row) => ({
          Put: {
            TableName: table,
            Item: marshall(row),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        })),
        ...introductionConditions(introduction),
      ],
      async () => {
        const [c, r] = await state();
        return same(c, ctl) && same(r, receipt);
      },
    );
    return { kind: "initialized" };
  }
  async function launch() {
    await identity();
    const [c, r] = await state();
    live(c, r);
    if (r.stage === "launched") return { kind: "launched" };
    if (r.stage !== "initialized") fail("Submitted launch cannot be replayed");
    await assertLegacyRuntimeStopped("Service is not empty");
    await topology(true);
    const d = (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: m.taskDefinition,
      })
    ).taskDefinition;
    assertPreparedCandidate(m, d);
    const launchAttemptId = randomUUID();
    await write(
      [
        controlCheck(),
        receiptUpdate("initialized", "launch_submitted", { launchAttemptId }),
      ],
      async () => {
        const [ctl, receipt] = await state();
        return (
          owned(ctl, receipt) &&
          receipt.stage === "launch_submitted" &&
          receipt.launchAttemptId === launchAttemptId
        );
      },
    );
    try {
      await aws("ecs", "update-service", {
        cluster: m.cluster,
        service: m.service,
        taskDefinition: m.taskDefinition,
        desiredCount: 1,
        deploymentConfiguration: {
          minimumHealthyPercent: 100,
          maximumPercent: 200,
          strategy: "ROLLING",
          earlySuccessCriteria: {
            enable: true,
            healthyPercent: 100,
            sourceServiceRevisionCleanup: "DEFERRED",
          },
        },
      });
    } catch {
      fail("Launch outcome unknown; do not replay or promote");
    }
    await write(
      [controlCheck(), receiptUpdate("launch_submitted", "launched")],
      async () => {
        const [ctl, receipt] = await state();
        return (
          owned(ctl, receipt) &&
          receipt.stage === "launched" &&
          receipt.launchAttemptId === launchAttemptId
        );
      },
    );
    return { kind: "launched" };
  }
  function notReady(message) {
    const error = new Error(message);
    error.code = "candidate_not_ready";
    throw error;
  }
  async function candidateTask() {
    const svc = await service(),
      running = await tasks();
    if (
      svc.desiredCount !== 1 ||
      svc.runningCount !== 1 ||
      svc.pendingCount !== 0 ||
      svc.taskDefinition !== m.taskDefinition ||
      running.length !== 1 ||
      running[0].taskDefinitionArn !== m.taskDefinition ||
      running[0].lastStatus !== "RUNNING"
    )
      notReady("Exact candidate task unavailable");
    return running[0];
  }
  function candidateContainer(task) {
    const container = task.containers.find((v) => v.name === m.containerName);
    if (
      container?.imageDigest !== m.imageDigest ||
      container.networkInterfaces?.length !== 1
    )
      fail("Candidate image/address mismatch");
    return container;
  }
  async function assertCandidateTargetHealthy(container) {
    const health = await aws("elbv2", "describe-target-health", {
      TargetGroupArn: m.targetGroupA,
    });
    if (
      health.TargetHealthDescriptions.length !== 1 ||
      health.TargetHealthDescriptions[0].Target.Id !==
        container.networkInterfaces[0].privateIpv4Address ||
      health.TargetHealthDescriptions[0].Target.Port !== m.containerPort ||
      health.TargetHealthDescriptions[0].TargetHealth.State !== "healthy"
    )
      notReady("Candidate target not healthy");
  }
  function assertCandidateRuntimeIdentity(row) {
    if (
      row.identity.kind !== "ecs" ||
      row.identity.imageDigest !== m.imageDigest ||
      row.identity.candidateId !== m.operationId ||
      row.role !== "candidate" ||
      row.retirementRequest ||
      row.retirementAcknowledgment ||
      !row.workCounts ||
      Object.values(row.workCounts).some((v) => v !== 0)
    )
      notReady("Candidate readiness is stale");
  }
  function assertCandidateReadiness(row) {
    if (
      row.readiness.runtimeMode !== m.runtimeMode ||
      !row.readiness.cacheReady ||
      !row.readiness.dependenciesReady ||
      (m.runtimeMode !== "api" && !row.readiness.gatewayReady) ||
      row.readiness.provenAt > now() ||
      row.readiness.expiresAt <= now() ||
      row.readiness.observedEpoch !== 1 ||
      row.readiness.observedGeneration !== 0 ||
      row.protection.provenAt > now() ||
      row.protection.expiresAt <= now() + 120
    )
      notReady("Candidate readiness is stale");
  }
  async function candidateRuntime(task) {
    const rows = await scan(table, "pk, sk, recordType, identity");
    const candidates = rows.filter(
      (v) => v.recordType === "runtime" && v.identity?.taskArn === task.taskArn,
    );
    if (candidates.length !== 1) notReady("Candidate registration ambiguous");
    const row = types.runtimeRecordSchema.parse(await read(candidates[0].sk));
    assertCandidateRuntimeIdentity(row);
    assertCandidateReadiness(row);
    return row;
  }
  async function assertNativeProtection(task) {
    const protection = await aws("ecs", "get-task-protection", {
      cluster: m.cluster,
      tasks: [task.taskArn],
    });
    const proof = protection.protectedTasks?.[0];
    if (
      protection.failures?.length ||
      protection.protectedTasks?.length !== 1 ||
      !sameEcsTaskArn(proof.taskArn, task.taskArn) ||
      !proof.protectionEnabled ||
      Date.parse(proof.expirationDate) / 1000 <= now() + 120
    )
      notReady("Native protection unconfirmed");
  }
  async function readyCandidate() {
    const task = await candidateTask();
    const container = candidateContainer(task);
    await topology(false);
    await assertCandidateTargetHealthy(container);
    const row = await candidateRuntime(task);
    await assertNativeProtection(task);
    return row;
  }
  async function readiness() {
    await identity();
    const [c, r] = await state();
    live(c, r);
    if (r.stage !== "launched") fail("Acknowledged launch required");
    try {
      await readyCandidate();
      return { kind: "ready" };
    } catch (error) {
      if (error.code === "candidate_not_ready") return { kind: "waiting" };
      throw error;
    }
  }
  async function promote(notAfter = Infinity) {
    await identity();
    const [c, r] = await state();
    if (
      owned(c, r) &&
      r.stage === "complete" &&
      c.servingGeneration === 1 &&
      same(c.servingMembers, { [r.candidate.instanceId]: r.candidate })
    )
      return { kind: "complete", receipt: "previously_confirmed" };
    live(c, r);
    if (r.stage !== "launched") fail("Acknowledged launch required");
    const row = await readyCandidate();
    const transaction = builders.buildPromotionTransaction({
      tables: { deploymentControl: table },
      coordinatorToken: m.operationId,
      coordinatorEpoch: 1,
      expectedServingGeneration: 0,
      expectedServingMembers: [],
      proposedGeneration: 1,
      candidate: row.identity,
      candidateRuntimeMode: m.runtimeMode,
      now: now(),
    });
    const update = transaction.TransactItems[0].Update;
    update.UpdateExpression += ", coordinatorExpiresAt = :released";
    update.ExpressionAttributeValues[":released"] = { N: "0" };
    transaction.TransactItems.push(
      receiptUpdate("launched", "complete", { candidate: row.identity }),
    );
    if (now() >= notAfter) fail("Candidate warmup deadline expired");
    await write(transaction.TransactItems, async () => {
      const [ctl, receipt] = await state(),
        current = await read(row.sk);
      return (
        owned(ctl, receipt) &&
        receipt.stage === "complete" &&
        same(receipt.candidate, row.identity) &&
        ctl.servingGeneration === 1 &&
        ctl.coordinatorExpiresAt === 0 &&
        same(ctl.servingMembers, { [row.identity.instanceId]: row.identity }) &&
        current?.role === "serving" &&
        current.authorizedGeneration === 1
      );
    });
    return { kind: "complete", generation: 1 };
  }
  return { initialize, launch, readiness, promote };
}
async function runCli(args = process.argv.slice(2), output = console) {
  try {
    const [phase, ...rest] = args;
    if (!["initialize", "launch", "promote", "dry-run"].includes(phase))
      throw new Error("Invalid phase");
    const options = readArguments(rest);
    const manifest = parseManifest(options.manifest, options.expectedSha256);
    if (phase === "dry-run") {
      output.log(
        JSON.stringify({
          kind: "dry-run",
          manifestSha256: options.expectedSha256,
          providerMutations: 0,
          identityVerification: "UNKNOWN",
        }),
      );
      return 0;
    }
    const result = await createBootstrap({ ...options, manifest })[phase]();
    output.log(JSON.stringify(result));
    return 0;
  } catch {
    output.error(
      JSON.stringify({
        kind: "bootstrap_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    return 1;
  }
}
module.exports = {
  createBootstrap,
  assertPreparedCandidate,
  assertTargetGroups,
  runCli,
};
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
