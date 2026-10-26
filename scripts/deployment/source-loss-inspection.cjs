"use strict";
const assert = require("node:assert/strict");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { createRuntimeProof } = require("./runtime-proof.cjs");
const { createRouting } = require("./routing.cjs");
const {
  CoordinatorFailure,
  listServiceTaskArns,
} = require("./coordinator-aws.cjs");
const { continuationBinding } = require("./continue-sandbox.cjs");
const { assertStoppedSource } = require("./source-task-proof.cjs");
function createSourceLossInspection({
  aws,
  config,
  env,
  types,
  now,
  terminalProof,
}) {
  const table = config.tablePrefix + "DeploymentControlTable";
  const read = async (pk, sk) => {
    const response = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: marshall({ pk, sk }),
      ConsistentRead: true,
    });
    return response.Item ? unmarshall(response.Item) : undefined;
  };
  const control = async () =>
    types.controlRecordSchema.parse(await read("ENV", "CONTROL"));
  const runtime = async (identity) => {
    const row = types.runtimeRecordSchema.parse(
      await read("ENV", `RUNTIME#${identity.instanceId}`),
    );
    assert.ok(types.sameRuntimeIdentity(row.identity, identity));
    return row;
  };
  const proof = createRuntimeProof({ aws, config, types, now, diagnostic: {} });
  const routing = createRouting({
    aws,
    config,
    env,
    failure: (category, message) => new CoordinatorFailure(category, message),
  });
  async function terminalTasks(ctl, candidate) {
    const d = ctl.deployment;
    const result = await aws("ecs", "describe-tasks", {
      cluster: config.cluster,
      tasks: [d.outgoing.taskArn, candidate.taskArn],
    });
    const destination = result.tasks?.find(
      (task) => task.taskArn === candidate.taskArn,
    );
    assert.equal(destination?.lastStatus, "RUNNING");
    assert.equal(destination.desiredStatus, "RUNNING");
    assert.equal(destination.group, "service:" + config.service);
    assert.equal(destination.taskDefinitionArn, d.taskDefinition);
    assert.equal(
      destination.containers?.find((c) => c.name === d.routing.containerName)
        ?.imageDigest,
      candidate.imageDigest,
    );
    if (terminalProof)
      return terminalProof.readSource(result, ctl, candidate, config);
    assert.ok(!result.failures?.length);
    assert.equal(result.tasks?.length, 2);
    const source = result.tasks.find(
      (task) => task.taskArn === d.outgoing.taskArn,
    );
    assertStoppedSource(source, d, config, now);
    return { stoppedAt: source.stoppedAt };
  }
  async function billingFlags(d) {
    const { taskDefinition } = await aws("ecs", "describe-task-definition", {
      taskDefinition: d.taskDefinition,
    });
    assert.equal(taskDefinition.taskDefinitionArn, d.taskDefinition);
    assert.equal(taskDefinition.family, config.family);
    const containers = taskDefinition.containerDefinitions.filter(
      (c) => c.name === d.routing.containerName,
    );
    assert.equal(containers.length, 1);
    assert.equal(containers[0].image, d.image);
    const names = [
      "STRIPE_MODE",
      "STRIPE_RENEWAL_GRACE_ENABLED",
      "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
      "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
      "STRIPE_RENEWAL_REACTIVATION_ENABLED",
    ];
    assert.ok(
      !containers[0].secrets?.some((entry) => names.includes(entry.name)),
    );
    const flags = {};
    for (const name of names) {
      const entries = containers[0].environment.filter(
        (entry) => entry.name === name,
      );
      assert.ok(entries.length <= 1);
      flags[name] = entries[0]?.value ?? "";
    }
    assert.equal(flags.STRIPE_MODE, "test");
    for (const name of names.slice(1, 4)) assert.notEqual(flags[name], "true");
    return flags;
  }
  async function native(ctl, candidate) {
    const d = ctl.deployment;
    const flags = await billingFlags(d);
    const response = await aws("ecs", "describe-services", {
      cluster: config.cluster,
      services: [config.service],
    });
    assert.ok(!response.failures?.length);
    assert.equal(response.services?.length, 1);
    const svc = response.services[0];
    assert.equal(svc.serviceName, config.service);
    assert.equal(svc.desiredCount, 1);
    assert.equal(svc.runningCount, 1);
    assert.equal(svc.pendingCount, 0);
    assert.equal(svc.deploymentController?.type, "ECS");
    assert.equal(svc.deploymentConfiguration?.strategy ?? "ROLLING", "ROLLING");
    assert.deepEqual(svc.deploymentConfiguration?.earlySuccessCriteria, {
      enable: true,
      healthyPercent: 100,
      sourceServiceRevisionCleanup: "DEFERRED",
    });
    assert.equal(svc.taskDefinition, d.taskDefinition);
    const arns = await listServiceTaskArns(aws, config);
    assert.deepEqual(arns, [candidate.taskArn]);
    const terminal = await terminalTasks(ctl, candidate);
    const nativeProtectionExpiresAt = await proof.protectedTask(candidate);
    const revision = await routing.validateSourceLoss(ctl, svc, candidate);
    return {
      ...terminal,
      candidateRevision: revision,
      billingFlags: flags,
      nativeProtectionExpiresAt,
    };
  }
  async function inspect() {
    const ctl = await control();
    const d = ctl.deployment;
    assert.equal(ctl.runtimeEnvironment, "ecs");
    assert.equal(ctl.coordinatorToken, d.runToken);
    for (const key of [
      "runToken",
      "cluster",
      "service",
      "family",
      "tablePrefix",
      "candidateId",
      "image",
    ])
      assert.equal(d[key], config[key]);
    assert.equal(d.phase, "warming");
    assert.equal(d.routing?.state, "source");
    assert.equal(d.candidate, undefined);
    assert.equal(ctl.servingGeneration, d.originalGeneration);
    assert.deepEqual(Object.values(ctl.servingMembers), [d.outgoing]);
    assert.deepEqual(d.originalMembers, [d.outgoing]);
    assert.equal(await read("SOURCELOSS#" + d.runToken, "RECOVERY"), undefined);
    const rows = [];
    let ExclusiveStartKey;
    do {
      const page = await aws("dynamodb", "query", {
        TableName: table,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: marshall({
          ":pk": "ENV",
          ":prefix": "RUNTIME#",
        }),
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      rows.push(
        ...(page.Items ?? []).map((item) =>
          types.runtimeRecordSchema.parse(unmarshall(item)),
        ),
      );
      assert.ok(rows.length <= 100);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    const matches = rows.filter(
      (row) =>
        row.identity.kind === "ecs" &&
        row.identity.candidateId === d.candidateId &&
        row.identity.imageDigest === d.image.split("@")[1] &&
        row.role === "candidate",
    );
    assert.equal(matches.length, 1);
    const warm = matches[0];
    assert.ok(!warm.retirementRequest && !warm.retirementAcknowledgment);
    assert.equal(warm.authorizedGeneration, ctl.servingGeneration);
    assert.ok(proof.ready(warm, ctl, warm.identity, d.runtimeMode));
    assert.ok(
      warm.workCounts &&
        Object.values(warm.workCounts).every((count) => count === 0),
    );
    terminalProof?.assertOriginal(ctl, warm.identity);
    const old = await runtime(d.outgoing);
    assert.equal(old.role, "serving");
    assert.equal(old.authorizedGeneration, d.originalGeneration);
    assert.ok(!old.retirementRequest && !old.retirementAcknowledgment);
    const { nativeProtectionExpiresAt: _expiresAt, ...terminal } = await native(
      ctl,
      warm.identity,
    );
    assert.ok(_expiresAt > now() + 120);
    await routing.assertAction(d.routing, false);
    return { control: ctl, candidateIdentity: warm.identity, terminal };
  }
  return { read, control, runtime, proof, routing, native, inspect };
}
function sourceLossBinding(control, candidateIdentity, terminal) {
  return {
    kind: terminal.terminalProof
      ? "sandbox_retained_source_loss"
      : "sandbox_source_loss",
    ...continuationBinding(control, candidateIdentity),
    terminal,
  };
}
module.exports = { createSourceLossInspection, sourceLossBinding };
