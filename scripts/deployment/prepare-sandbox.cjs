"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const {
  parseManifest,
  manifestHash,
  awsCaller,
} = require("./sandbox-manifest.cjs");
const { candidateDefinition, runtimeMode } = require("./coordinator.cjs");
const uuid = z.string().uuid();
function sessionName(operationId) {
  uuid.parse(operationId);
  return (
    "chronote-sandbox-" + BigInt("0x" + operationId.replaceAll("-", "")) + "-1"
  );
}
function bindJob(env) {
  assert.equal(
    env.GITHUB_RUN_ATTEMPT,
    "1",
    "Reruns require explicit reconciliation",
  );
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/);
  assert.match(env.EXPECTED_ACCOUNT_ID, /^\d{12}$/);
  const rolePrefix = "arn:aws:iam::" + env.EXPECTED_ACCOUNT_ID + ":role/";
  assert(env.EXPECTED_ROLE_ARN.startsWith(rolePrefix));
  const role = env.EXPECTED_ROLE_ARN.slice(rolePrefix.length);
  assert.match(role, /^[a-z0-9-]*sandbox[a-z0-9-]*-github-deploy$/);
  if (env.BOOTSTRAP_PHASE === "prepare") {
    uuid.parse(env.BOOTSTRAP_OPERATION_ID);
    assert.match(env.GITHUB_RUN_ID, /^\d+$/);
    return { sessionName: "chronote-sandbox-" + env.GITHUB_RUN_ID + "-1" };
  }
  assert(["activate", "repair"].includes(env.BOOTSTRAP_PHASE));
  const payload = JSON.parse(env.BOOTSTRAP_MANIFEST_JSON);
  let manifestInput = payload,
    previousManifest;
  if (env.BOOTSTRAP_PHASE === "repair") {
    assert.equal(manifestHash(payload), env.BOOTSTRAP_MANIFEST_SHA256);
    assert.deepEqual(Object.keys(payload).sort(), [
      "manifest",
      "previousManifest",
    ]);
    manifestInput = payload.manifest;
    previousManifest = payload.previousManifest;
    parseManifest(previousManifest, manifestHash(previousManifest));
  }
  const expectedSha256 =
    env.BOOTSTRAP_PHASE === "repair"
      ? manifestHash(manifestInput)
      : env.BOOTSTRAP_MANIFEST_SHA256;
  const manifest = parseManifest(manifestInput, expectedSha256);
  assert.equal(manifest.operationId, env.BOOTSTRAP_OPERATION_ID);
  const name = sessionName(manifest.operationId);
  assert.equal(manifest.sourceCommit, env.GITHUB_SHA);
  assert.equal(manifest.accountId, env.EXPECTED_ACCOUNT_ID);
  assert.equal(
    manifest.principalArn,
    "arn:aws:sts::" + manifest.accountId + ":assumed-role/" + role + "/" + name,
  );
  return {
    sessionName: name,
    manifest: manifestInput,
    manifestSha256: expectedSha256,
    ...(previousManifest
      ? {
          previousManifest,
          previousManifestSha256: manifestHash(previousManifest),
        }
      : {}),
  };
}
async function assertSourceImage(m, image, aws) {
  const prefix = m.accountId + ".dkr.ecr." + m.region + ".amazonaws.com/";
  assert(image.startsWith(prefix));
  const [repository, digest] = image.slice(prefix.length).split("@");
  assert.match(repository, /^[a-z0-9-]*sandbox[a-z0-9-]*$/);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(image, prefix + repository + "@" + digest);
  const response = await aws("ecr", "describe-images", {
    repositoryName: repository,
    imageIds: [{ imageTag: m.sourceCommit }],
  });
  assert.equal(response.imageDetails.length, 1);
  assert.equal(response.imageDetails[0].imageDigest, digest);
  assert(response.imageDetails[0].imageTags.includes(m.sourceCommit));
}
async function prepare(env, aws = awsCaller(env.AWS_REGION)) {
  const binding = bindJob({ ...env, BOOTSTRAP_PHASE: "prepare" });
  const actor = await aws("sts", "get-caller-identity", {});
  const expected =
    env.EXPECTED_ROLE_ARN.replace(":iam::", ":sts::").replace(
      ":role/",
      ":assumed-role/",
    ) +
    "/" +
    binding.sessionName;
  assert.equal(actor.Arn, expected);
  assert.equal(actor.Account, env.EXPECTED_ACCOUNT_ID);
  for (const value of [
    env.ECS_CLUSTER,
    env.ECS_SERVICE,
    env.ECS_TASK_FAMILY,
    env.SECRETS_PREFIX,
  ]) {
    assert.match(value, /^[a-z0-9-]*sandbox[a-z0-9-]*$/);
  }
  const config = {
    image: env.CANDIDATE_IMAGE,
    candidateId: env.BOOTSTRAP_OPERATION_ID,
    tablePrefix: env.SECRETS_PREFIX + "-",
  };
  assert.match(
    config.image,
    new RegExp(
      "^" +
        env.EXPECTED_ACCOUNT_ID +
        "\\.dkr\\.ecr\\." +
        env.AWS_REGION +
        "\\.amazonaws\\.com/[a-z0-9-]*sandbox[a-z0-9-]*@sha256:[a-f0-9]{64}$",
    ),
  );
  assert.match(env.AWS_REGION, /^[a-z]{2}-[a-z]+-[0-9]$/);
  await assertSourceImage(
    {
      accountId: env.EXPECTED_ACCOUNT_ID,
      region: env.AWS_REGION,
      sourceCommit: env.GITHUB_SHA,
    },
    config.image,
    aws,
  );
  let nextToken,
    count = 0;
  do {
    const page = await aws("ecs", "list-task-definitions", {
      familyPrefix: env.ECS_TASK_FAMILY,
      status: "ACTIVE",
      maxResults: 100,
      ...(nextToken ? { nextToken } : {}),
    });
    for (const arn of page.taskDefinitionArns) {
      assert(++count <= 1000);
      const d = (
        await aws("ecs", "describe-task-definition", { taskDefinition: arn })
      ).taskDefinition;
      assert.equal(d.family, env.ECS_TASK_FAMILY);
      assert(
        !d.containerDefinitions.some((c) =>
          c.environment?.some(
            (e) =>
              e.name === "DEPLOYMENT_CANDIDATE_ID" &&
              e.value === config.candidateId,
          ),
        ),
        "Candidate already registered; reconcile it",
      );
    }
    nextToken = page.nextToken;
  } while (nextToken);
  const definition = (
    await aws("ecs", "describe-task-definition", {
      taskDefinition: env.ECS_TASK_FAMILY,
    })
  ).taskDefinition;
  assert.equal(definition.family, env.ECS_TASK_FAMILY);
  const next = candidateDefinition(definition, config);
  const container = next.containerDefinitions.find((c) =>
    c.environment?.some((e) => e.name === "DDB_TABLE_PREFIX"),
  );
  assert.equal(runtimeMode(container), "all");
  assert(
    !container.secrets?.some((e) =>
      [
        "DDB_TABLE_PREFIX",
        "TRANSCRIPTS_BUCKET",
        "DEPLOYMENT_CANDIDATE_ID",
      ].includes(e.name),
    ),
  );
  const roleBase =
    "arn:aws:iam::" + env.EXPECTED_ACCOUNT_ID + ":role/" + env.SECRETS_PREFIX;
  assert.equal(next.taskRoleArn, roleBase + "-ecs-task-app-role");
  assert.equal(next.executionRoleArn, roleBase + "-ecs-task-exec-role");
  for (const secret of container.secrets ?? []) {
    assert(
      secret.valueFrom.startsWith(
        "arn:aws:secretsmanager:" +
          env.AWS_REGION +
          ":" +
          env.EXPECTED_ACCOUNT_ID +
          ":secret:" +
          env.SECRETS_PREFIX +
          "/",
      ),
    );
  }
  container.command = ["node", "dist/index.js"];
  // Registration is attempted once; an unknown acknowledgment requires operator reconciliation.
  const registered = await aws("ecs", "register-task-definition", next);
  assert.equal(registered.taskDefinition.family, env.ECS_TASK_FAMILY);
  assert.equal(registered.taskDefinition.status, "ACTIVE");
  assert(
    registered.taskDefinition.containerDefinitions.some(
      (c) => c.image === config.image,
    ),
  );
  return { kind: "prepared" };
}
module.exports = { bindJob, prepare, assertSourceImage };
