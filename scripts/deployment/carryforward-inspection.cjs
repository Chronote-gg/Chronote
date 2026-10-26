"use strict";
const assert = require("node:assert/strict");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { bindingHash } = require("./binding-hash.cjs");
const {
  candidateDefinition,
  taskContainer,
  runtimeMode,
} = require("./coordinator.cjs");
const { controlAuthority } = require("./carryforward-state.cjs");
const { receiptSchema } = require("./source-loss-state.cjs");
const { createRuntimeProof } = require("./runtime-proof.cjs");
const { assertSandboxScope } = require("./continue-sandbox.cjs");
const capabilityFlags = [
  "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
  "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
  "STRIPE_RENEWAL_GRACE_ENABLED",
];
function createCarryforwardInspection({
  aws,
  coordinator,
  config,
  env,
  types,
  manifest,
  manifestSha256,
  now,
  validateScope = assertSandboxScope,
}) {
  const table = config.tablePrefix + "DeploymentControlTable";
  async function read(pk, sk) {
    const response = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: marshall({ pk, sk }),
      ConsistentRead: true,
    });
    return response.Item ? unmarshall(response.Item) : undefined;
  }
  const control = async () =>
    types.controlRecordSchema.parse(await read("ENV", "CONTROL"));
  const proof = createRuntimeProof({ aws, config, types, now, diagnostic: {} });
  const archiveKey = "CARRYFORWARD#" + manifest.operationId;
  function values(container, name) {
    assert.ok(!container.secrets?.some((entry) => entry.name === name));
    const entries = container.environment.filter(
      (entry) => entry.name === name,
    );
    assert.equal(entries.length, 1);
    return entries[0].value;
  }
  function unchangedSettings(definition) {
    const next = candidateDefinition(definition, config);
    const container = taskContainer(next, config.tablePrefix);
    container.environment = container.environment.filter(
      (entry) => !capabilityFlags.includes(entry.name),
    );
    return next;
  }
  async function template(sourceDefinition, mode) {
    const destination = (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: manifest.templateArn,
      })
    ).taskDefinition;
    const source = (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: sourceDefinition,
      })
    ).taskDefinition;
    assert.equal(destination.taskDefinitionArn, manifest.templateArn);
    assert.equal(destination.family, config.family);
    const prepared = candidateDefinition(destination, config);
    assert.equal(bindingHash(prepared), manifest.preparedDefinitionSha256);
    const container = taskContainer(prepared, config.tablePrefix);
    assert.equal(runtimeMode(container), mode);
    assert.equal(values(container, "STRIPE_MODE"), "test");
    const original = taskContainer(source, config.tablePrefix);
    const clientId = values(original, "DISCORD_CLIENT_ID");
    assert.match(clientId, /^\d{17,20}$/);
    assert.equal(values(container, "DISCORD_CLIENT_ID"), clientId);
    for (const key of capabilityFlags)
      assert.ok(["true", "false"].includes(values(container, key)));
    assert.deepEqual(unchangedSettings(destination), unchangedSettings(source));
    return manifest.preparedDefinitionSha256;
  }
  async function inspect() {
    const observed = await coordinator.inspectServing();
    const ctl = observed.control,
      d = ctl.deployment;
    validateScope(env, ctl);
    validateScope(env, {
      ...ctl,
      deployment: {
        ...d,
        image: manifest.image,
        taskDefinition: manifest.templateArn,
      },
    });
    assert.equal(ctl.coordinatorToken, manifest.originalRunToken);
    assert.equal(d.runToken, manifest.originalRunToken);
    assert.equal(d.phase, "promoted");
    assert.equal(d.routing.state, "candidate");
    assert.deepEqual(observed.routing, {
      listenerArn: d.routing.listenerArn,
      sourceGroup: d.routing.candidateGroup,
      candidateGroup: d.routing.sourceGroup,
      containerName: d.routing.containerName,
      containerPort: d.routing.containerPort,
      sourceRevision: d.routing.candidateRevision,
      state: "source",
    });
    assert.deepEqual(d.candidate, observed.source);
    assert.deepEqual(Object.values(ctl.servingMembers), [observed.source]);
    assert.equal(ctl.servingGeneration, d.originalGeneration + 1);
    assert.equal(observed.serviceDefinition, d.taskDefinition);
    assert.equal(observed.service.serviceName, config.service);
    assert.equal(observed.service.runningCount, 1);
    assert.equal(observed.service.pendingCount, 0);
    assert.deepEqual(
      observed.service.deploymentConfiguration.earlySuccessCriteria,
      {
        enable: true,
        healthyPercent: 100,
        sourceServiceRevisionCleanup: "DEFERRED",
      },
    );
    assert.ok(
      ctl.coordinatorExpiresAt <= now(),
      "Prior coordinator lease is still live",
    );
    assert.equal(bindingHash(controlAuthority(ctl)), manifest.controlSha256);
    assert.equal(
      await read(archiveKey, "ARCHIVE"),
      undefined,
      "Operation approval already consumed",
    );
    const recovery = receiptSchema(types).parse(
      await read("SOURCELOSS#" + d.runToken, "RECOVERY"),
    );
    assert.equal(recovery.version, 2);
    assert.equal(recovery.stage, "availability_restored");
    assert.equal(recovery.settlement, "lost_owner_settlement_pending");
    assert.deepEqual(recovery.source, d.outgoing);
    assert.deepEqual(recovery.candidate, observed.source);
    assert.equal(bindingHash(recovery), manifest.recoverySha256);
    const preparedDefinitionSha256 = await template(
      d.taskDefinition,
      observed.runtimeMode,
    );
    const fresh = await control();
    assert.deepEqual(controlAuthority(fresh), controlAuthority(ctl));
    const row = types.runtimeRecordSchema.parse(
      await read("ENV", "RUNTIME#" + observed.source.instanceId),
    );
    assert.ok(proof.ready(row, fresh, observed.source, observed.runtimeMode));
    assert.equal(row.role, "serving");
    assert.equal(row.authorizedGeneration, ctl.servingGeneration);
    assert.ok(!row.retirementRequest && !row.retirementAcknowledgment);
    assert.ok(observed.nativeProtectionExpiresAt > now() + 120);
    const result = {
      control: fresh,
      recovery,
      source: observed.source,
      routing: observed.routing,
      runtimeMode: observed.runtimeMode,
      preparedDefinitionSha256,
      nativeProtectionExpiresAt: observed.nativeProtectionExpiresAt,
    };
    const binding = {
      kind: "sandbox_historical_carryforward",
      manifestSha256,
      control: controlAuthority(fresh),
      recoverySha256: bindingHash(recovery),
      source: result.source,
      routing: result.routing,
      runtimeMode: result.runtimeMode,
      preparedDefinitionSha256,
    };
    return { ...result, binding, bindingSha256: bindingHash(binding) };
  }
  return { read, control, inspect, archiveKey, template };
}
module.exports = { createCarryforwardInspection };
