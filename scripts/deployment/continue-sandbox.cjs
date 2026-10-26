"use strict";
const assert = require("node:assert/strict");
const { bindingHash } = require("./binding-hash.cjs");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { createCoordinator, awsCli } = require("./coordinator.cjs");
const { assertSandboxIdentity } = require("./assert-sandbox-identity.cjs");

function continuationBinding(control, candidateIdentity) {
  const d = control.deployment;
  return {
    version: 1,
    coordinatorToken: control.coordinatorToken,
    coordinatorEpoch: control.coordinatorEpoch,
    servingGeneration: control.servingGeneration,
    servingMembers: Object.values(control.servingMembers).sort((a, b) =>
      a.instanceId.localeCompare(b.instanceId),
    ),
    deployment: {
      runToken: d.runToken,
      cluster: d.cluster,
      service: d.service,
      family: d.family,
      tablePrefix: d.tablePrefix,
      candidateId: d.candidateId,
      image: d.image,
      runtimeMode: d.runtimeMode,
      originalGeneration: d.originalGeneration,
      originalMembers: [...d.originalMembers].sort((a, b) =>
        a.instanceId.localeCompare(b.instanceId),
      ),
      outgoing: d.outgoing,
      previousTaskDefinition: d.previousTaskDefinition,
      taskDefinition: d.taskDefinition,
      routing: d.routing,
    },
    candidateIdentity,
  };
}
function assertSandboxScope(env, control) {
  assert.equal(env.CONTINUATION_ENVIRONMENT, "sandbox");
  assert.match(env.AWS_REGION, /^[a-z]{2}-[a-z]+-\d$/);
  assert.match(env.EXPECTED_ACCOUNT_ID, /^\d{12}$/);
  const d = control.deployment;
  for (const [key, value] of Object.entries({
    ECS_CLUSTER: d.cluster,
    ECS_SERVICE: d.service,
    ECS_TASK_FAMILY: d.family,
    SECRETS_PREFIX: d.tablePrefix.slice(0, -1),
  })) {
    assert.match(value, /^[a-z0-9-]*sandbox[a-z0-9-]*$/);
    assert.equal(env[key], value);
  }
  assert.equal(d.tablePrefix, env.SECRETS_PREFIX + "-");
  const ecs = `arn:aws:ecs:${env.AWS_REGION}:${env.EXPECTED_ACCOUNT_ID}:`;
  for (const definition of [d.taskDefinition, d.previousTaskDefinition])
    assert.match(
      definition,
      new RegExp(`^${ecs}task-definition/${d.family}:\\d+$`),
    );
  for (const identity of [...d.originalMembers])
    assert.ok(
      identity.kind === "ecs" && identity.taskArn.startsWith(ecs + "task/"),
    );
  assert.ok(
    d.image.startsWith(
      `${env.EXPECTED_ACCOUNT_ID}.dkr.ecr.${env.AWS_REGION}.amazonaws.com/`,
    ),
  );
  assert.match(d.image, /\/[^/@]*sandbox[^/@]*@sha256:[a-f0-9]{64}$/);
  const elb = `arn:aws:elasticloadbalancing:${env.AWS_REGION}:${env.EXPECTED_ACCOUNT_ID}:`;
  assert.ok(d.routing.listenerArn.startsWith(elb + "listener/app/"));
  assert.ok(
    [d.routing.sourceGroup, d.routing.candidateGroup].every(
      (arn) => arn.startsWith(elb + "targetgroup/") && arn.includes("sandbox"),
    ),
  );
}
async function continueSandbox(options = {}) {
  const env = options.env ?? process.env;
  assert.ok(
    !Object.keys(env).some(
      (key) => key.startsWith("AWS_ENDPOINT_URL") && env[key],
    ),
  );
  const aws = options.aws ?? awsCli;
  assertSandboxIdentity(await aws("sts", "get-caller-identity", {}), env);
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  const response = await aws("dynamodb", "get-item", {
    TableName: `${env.SECRETS_PREFIX}-DeploymentControlTable`,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ConsistentRead: true,
  });
  const control = types.controlRecordSchema.parse(unmarshall(response.Item));
  const validateScope = options.validateScope ?? assertSandboxScope;
  validateScope(env, control);
  const d = control.deployment;
  const configEnv = {
    ...env,
    DEPLOYMENT_RUN_TOKEN: d.runToken,
    DEPLOYMENT_CANDIDATE_ID: d.candidateId,
    CANDIDATE_IMAGE: d.image,
  };
  const factory = options.coordinatorFactory ?? createCoordinator;
  const baseOptions = { ...options, env: configEnv, aws };
  const inspector = factory(baseOptions);
  const observed = await inspector.inspectContinuation();
  const binding = continuationBinding(
    observed.control,
    observed.candidateIdentity,
  );
  const hash = bindingHash(binding);
  if (options.mode === "inspect")
    return { kind: "inspection", bindingSha256: hash, binding };
  assert.match(
    options.expectedBindingSha256 ?? env.CONTINUATION_BINDING_SHA256,
    /^[a-f0-9]{64}$/,
  );
  assert.equal(
    hash,
    options.expectedBindingSha256 ?? env.CONTINUATION_BINDING_SHA256,
  );
  let firstControlRead = true;
  const guardedAws = async (service, operation, input) => {
    const response = await aws(service, operation, input);
    if (
      firstControlRead &&
      service === "dynamodb" &&
      operation === "get-item" &&
      unmarshall(input.Key).sk === "CONTROL"
    ) {
      firstControlRead = false;
      const snapshot = types.controlRecordSchema.parse(
        unmarshall(response.Item),
      );
      assert.equal(
        bindingHash(continuationBinding(snapshot, observed.candidateIdentity)),
        hash,
      );
      const fresh = await inspector.inspectContinuation();
      assert.equal(
        bindingHash(
          continuationBinding(fresh.control, fresh.candidateIdentity),
        ),
        hash,
      );
    }
    return response;
  };
  const coordinator = factory({
    ...baseOptions,
    aws: guardedAws,
    expectedCandidate: observed.candidateIdentity,
  });
  const promoted = await coordinator.promote();
  assert.equal(promoted.kind, "promoted");
  return coordinator.retire();
}
module.exports = {
  continueSandbox,
  continuationBinding,
  bindingHash,
  assertSandboxScope,
};
if (require.main === module) {
  const mode = process.argv[2];
  Promise.resolve()
    .then(() => {
      assert.ok(["inspect", "continue"].includes(mode));
      return continueSandbox({ mode });
    })
    .then((result) =>
      console.log(
        JSON.stringify({
          kind: result.kind,
          bindingSha256: result.bindingSha256,
        }),
      ),
    )
    .catch(() => {
      console.error(
        JSON.stringify({
          kind: "continuation_failed",
          action: "preserve_receipts_and_review_current_state",
        }),
      );
      process.exitCode = 1;
    });
}
