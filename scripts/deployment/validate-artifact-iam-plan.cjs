"use strict";
const assert = require("node:assert/strict");
const { storageBinding } = require("./private-capture.cjs");
const { canonical, hasUnknown } = require("./terraform-meeting-update.cjs");
const {
  assertOtherwiseUnchanged,
  validateScopedPlan,
  assertPlanEnvelope,
} = require("./validate-prerequisite-plan.cjs");
const {
  artifactIamModelEvidence,
  artifactIamObservationTargets,
  artifactIamDependencyIdentities,
} = require("./artifact-iam-model.cjs");
const transcriptPolicy = "aws_iam_policy.transcripts_s3_policy";
const profile = (environment) => {
  assert.ok(["sandbox", "production"].includes(environment));
  return environment === "sandbox" ? "sandbox" : "production";
};
function artifactIamTargets(environment) {
  return new Map([
    [transcriptPolicy, ["update"]],
    [`aws_iam_role_policy.${profile(environment)}_deploy[0]`, ["update"]],
  ]);
}
function configured(tfvars, variables, name, fallback) {
  const aliases = Object.keys(variables).filter(
    (k) => k.toLowerCase() === `tfvar_${name}`.toLowerCase(),
  );
  assert.ok(aliases.length <= 1, "Ambiguous artifact IAM input");
  let value = tfvars[name] ?? fallback;
  if (aliases.length) {
    assert.equal(aliases[0], `TFVAR_${name}`, "Unsupported Terraform alias");
    const override = variables[aliases[0]];
    assert.equal(typeof override, "string");
    if (override.trim()) value = override.trim();
  }
  assert.equal(typeof value, "string");
  return value;
}
function artifactIamBinding({ invocation, storage, variables, tfvars }) {
  profile(invocation.environment);
  assert.equal(
    invocation.workspace,
    invocation.environment === "sandbox" ? "sandbox" : "default",
  );
  const s = storageBinding.parse(storage);
  assert.equal(s.region, "us-east-1");
  assert.equal(variables.AWS_ACCOUNT_ID, s.accountId);
  assert.equal(variables.AWS_REGION, s.region);
  const applicationKey = variables.ARTIFACT_APP_KMS_KEY_ARN;
  assert.equal(typeof applicationKey, "string");
  assert.match(
    applicationKey,
    new RegExp(`^arn:aws:kms:${s.region}:${s.accountId}:key/[a-f0-9-]{36}$`),
  );
  const githubOwner = configured(
    tfvars,
    variables,
    "github_owner",
    "Chronote-gg",
  );
  const githubRepository = configured(
    tfvars,
    variables,
    "github_repository",
    "Chronote",
  );
  assert.equal(
    `${githubOwner}/${githubRepository}`.toLowerCase(),
    (invocation.repository ?? "Chronote-gg/Chronote").toLowerCase(),
  );
  const env = invocation.environment === "sandbox" ? "sandbox" : "prod";
  assert.equal(configured(tfvars, variables, "environment", env), env);
  assert.equal(
    configured(tfvars, variables, "aws_region", "us-east-1"),
    s.region,
  );
  assert.equal(
    configured(tfvars, variables, "github_environment", "production"),
    invocation.environment,
  );
  const project = configured(
    tfvars,
    variables,
    "project_name",
    "meeting-notes",
  );
  assert.match(project, /^[a-z][a-z0-9-]{1,40}$/);
  const prefix = `${project}-${env}`;
  const bucket =
    configured(tfvars, variables, "TRANSCRIPTS_BUCKET", "") ||
    `${prefix}-transcripts-${s.accountId}`;
  assert.match(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  assert.ok(!bucket.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(bucket));
  const arn = `arn:aws:iam::${s.accountId}:role/`;
  const deploymentRoleArn = `${arn}${prefix}-github-deploy`;
  assert.equal(
    variables[
      `${invocation.environment === "sandbox" ? "SANDBOX" : "PRODUCTION"}_BACKEND_DEPLOY_ROLE_ARN`
    ],
    deploymentRoleArn,
  );
  return {
    environment: invocation.environment,
    projectName: project,
    githubOwner,
    githubRepository,
    controlTableName: `${prefix}-DeploymentControlTable`,
    controlTableArn: `arn:aws:dynamodb:${s.region}:${s.accountId}:table/${prefix}-DeploymentControlTable`,
    accountId: s.accountId,
    region: s.region,
    prefix,
    transcriptsBucket: bucket,
    kmsKeyArn: applicationKey,
    captureKmsKeyArn: s.kmsKeyArn,
    deploymentRoleArn,
    applicationRoleArn: `${arn}${prefix}-ecs-task-app-role`,
    executionRoleArn: `${arn}${prefix}-ecs-task-exec-role`,
    meetingHistoryArn: `arn:aws:dynamodb:${s.region}:${s.accountId}:table/${prefix}-MeetingHistoryTable`,
  };
}
function unchanged(change) {
  assert.ok(
    change.before && change.after && !hasUnknown(change.after_unknown ?? {}),
  );
  assert.deepEqual(change.before, change.after);
}
function policyDocument(text) {
  assert.equal(typeof text, "string");
  const doc = JSON.parse(text);
  assert.ok(doc && typeof doc === "object" && !Array.isArray(doc));
  assert.equal(doc.Version, "2012-10-17");
  assert.ok(Array.isArray(doc.Statement));
  return doc;
}
const equal = (left, right) => assert.equal(canonical(left), canonical(right));
function checkTranscript(change, b) {
  assertOtherwiseUnchanged(
    {
      before: change.before,
      after: change.after,
      unknown: change.after_unknown ?? {},
    },
    ["policy"],
  );
  const policyArn = `arn:aws:iam::${b.accountId}:policy/${b.prefix}-bot-transcripts-s3-policy`;
  assert.equal(change.after.name, `${b.prefix}-bot-transcripts-s3-policy`);
  assert.equal(change.after.arn, policyArn);
  assert.equal(change.after.id, policyArn);
  assert.ok(!hasUnknown(change.after_unknown ?? {}));
  const before = policyDocument(change.before.policy),
    after = policyDocument(change.after.policy);
  const baseActions = [
    "s3:PutObject",
    "s3:GetObject",
    "s3:AbortMultipartUpload",
    "s3:ListBucket",
  ];
  const bucket = `arn:aws:s3:::${b.transcriptsBucket}`;
  equal(after, {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [...baseActions, "s3:GetObjectVersion"],
        Resource: [bucket, `${bucket}/*`],
      },
    ],
  });
  const prior = structuredClone(after);
  prior.Statement[0].Action = baseActions;
  assert.ok(
    canonical(before) === canonical(prior) ||
      canonical(before) === canonical(after),
    "Unexpected transcript permission delta",
  );
}
function checkDeployment(change, b) {
  assertOtherwiseUnchanged(
    {
      before: change.before,
      after: change.after,
      unknown: change.after_unknown ?? {},
    },
    ["policy"],
  );
  assert.ok(!hasUnknown(change.after_unknown ?? {}));
  assert.equal(change.after.name, `${b.prefix}-backend-deploy`);
  assert.equal(change.after.role, `${b.prefix}-github-deploy`);
  const before = policyDocument(change.before.policy),
    after = policyDocument(change.after.policy);
  const added = {
    Sid: "ArtifactAuthorityChecks",
    Effect: "Allow",
    Action: ["dynamodb:ConditionCheckItem"],
    Resource: b.meetingHistoryArn,
  };
  const current = after.Statement.filter((s) => s.Sid === added.Sid);
  assert.equal(current.length, 1);
  equal(current[0], added);
  const previous = before.Statement.filter((s) => s.Sid === added.Sid);
  assert.ok(previous.length <= 1);
  if (previous.length) equal(previous[0], added);
  equal(
    {
      ...before,
      Statement: before.Statement.filter((s) => s.Sid !== added.Sid),
    },
    { ...after, Statement: after.Statement.filter((s) => s.Sid !== added.Sid) },
  );
}
function checkDependencies(resources, b) {
  const state = (address) => {
    const r = resources.get(address);
    assert.ok(r, "Missing artifact IAM observation");
    unchanged(r.change);
    return r.change.after;
  };
  for (const address of artifactIamObservationTargets(b.environment))
    state(address);
  const bucketArn = `arn:aws:s3:::${b.transcriptsBucket}`;
  assert.equal(state("aws_s3_bucket.transcripts").bucket, b.transcriptsBucket);
  assert.equal(state("aws_s3_bucket.transcripts").arn, bucketArn);
  assert.equal(
    state("aws_dynamodb_table.meeting_history_table").arn,
    b.meetingHistoryArn,
  );
  for (const [address, arn] of [
    ["aws_iam_role.ecs_task_app_role", b.applicationRoleArn],
    ["aws_iam_role.ecs_task_execution_role", b.executionRoleArn],
    [`aws_iam_role.${profile(b.environment)}_deploy[0]`, b.deploymentRoleArn],
  ]) {
    const role = state(address);
    assert.equal(role.arn, arn);
    assert.equal(role.name, arn.split("/").at(-1));
  }
  for (const [address, role] of [
    ["ecs_task_transcripts_policy", b.applicationRoleArn],
    ["ecs_task_exec_transcripts_policy", b.executionRoleArn],
  ]) {
    const attachment = state(`aws_iam_role_policy_attachment.${address}`);
    assert.equal(attachment.role, role.split("/").at(-1));
    assert.equal(
      attachment.policy_arn,
      `arn:aws:iam::${b.accountId}:policy/${b.prefix}-bot-transcripts-s3-policy`,
    );
  }
  const key = state("aws_kms_key.app_general").arn;
  assert.equal(key, b.kmsKeyArn);
  assert.match(
    key,
    new RegExp(`^arn:aws:kms:${b.region}:${b.accountId}:key/[a-f0-9-]{36}$`),
  );
  const encryption = state(
    "aws_s3_bucket_server_side_encryption_configuration.transcripts",
  );
  assert.equal(encryption.bucket, b.transcriptsBucket);
  assert.equal(encryption.rule.length, 1);
  equal(encryption.rule[0].apply_server_side_encryption_by_default, [
    { sse_algorithm: "aws:kms", kms_master_key_id: key },
  ]);
  const versioning = state("aws_s3_bucket_versioning.transcripts");
  assert.equal(versioning.bucket, b.transcriptsBucket);
  assert.equal(versioning.versioning_configuration[0].status, "Enabled");
}
function checkDependencyIdentity(r, b, identities) {
  const expected = identities.get(r.address),
    after = r.change.after;
  if (expected) {
    const { arnPrefix, ...fields } = expected;
    for (const [field, value] of Object.entries(fields))
      assert.equal(
        after[field],
        value,
        "Foreign artifact IAM dependency identity",
      );
    if (arnPrefix) {
      assert.equal(typeof after.arn, "string");
      assert.ok(
        after.arn.startsWith(arnPrefix) &&
          /^[A-Za-z0-9]{6}$/.test(after.arn.slice(arnPrefix.length)),
        "Foreign artifact IAM secret identity",
      );
    }
  } else
    assert.ok(
      artifactIamObservationTargets(b.environment).includes(r.address),
      "Unmodelled artifact IAM identity",
    );
  if (after.region != null)
    assert.equal(
      after.region,
      b.region,
      "Foreign artifact IAM dependency region",
    );
  if (
    r.address === "aws_ecr_repository.app_ecr_repo" &&
    after.registry_id != null
  )
    assert.equal(after.registry_id, b.accountId);
}
function checkMetadata(resource, b) {
  const deploy =
    b.environment === "sandbox" ? "github_deploy" : "github_production_deploy";
  const organization =
    b.environment === "sandbox"
      ? "deployment_owner"
      : "production_deployment_owner";
  assert.ok(
    [
      "data.aws_caller_identity.current",
      `data.aws_iam_openid_connect_provider.${deploy}[0]`,
      "data.github_repository.repo",
      `data.github_organization.${organization}[0]`,
    ].includes(resource.address),
    "Outside artifact IAM metadata closure",
  );
  const c = resource.change;
  assert.ok(c.actions.length === 1 && ["read", "no-op"].includes(c.actions[0]));
  assert.ok(
    c.after && !hasUnknown(c.after_unknown ?? {}),
    "Unknown artifact IAM metadata",
  );
  if (resource.address === "data.aws_caller_identity.current") {
    assert.equal(c.after.account_id, b.accountId);
    assert.match(
      c.after.arn,
      new RegExp(`^arn:aws:(iam|sts)::${b.accountId}:`),
    );
  }
  if (
    resource.address === `data.aws_iam_openid_connect_provider.${deploy}[0]`
  ) {
    assert.equal(
      c.after.arn,
      `arn:aws:iam::${b.accountId}:oidc-provider/token.actions.githubusercontent.com`,
    );
    assert.ok(
      [
        "token.actions.githubusercontent.com",
        "https://token.actions.githubusercontent.com",
      ].includes(c.after.url),
      "Foreign artifact IAM OIDC issuer",
    );
    assert.ok(
      Array.isArray(c.after.client_id_list) &&
        c.after.client_id_list.includes("sts.amazonaws.com"),
      "Foreign artifact IAM OIDC audience",
    );
  }
  if (resource.address === "data.github_repository.repo") {
    assert.equal(
      c.after.full_name.toLowerCase(),
      `${b.githubOwner}/${b.githubRepository}`.toLowerCase(),
      "Foreign artifact IAM repository",
    );
    assert.equal(c.after.name.toLowerCase(), b.githubRepository.toLowerCase());
  }
  if (resource.address === `data.github_organization.${organization}[0]`)
    assert.equal(
      c.after.name.toLowerCase(),
      b.githubOwner.toLowerCase(),
      "Foreign artifact IAM organization",
    );
}
function validateArtifactIamPlan(plan, b, options = {}) {
  assertPlanEnvelope(plan);
  assert.equal(plan.terraform_version, "1.17.1");
  for (const [name, value] of Object.entries({
    environment: b.environment === "sandbox" ? "sandbox" : "prod",
    project_name: b.projectName,
    aws_region: b.region,
    github_environment: b.environment,
    ENABLE_API_ALB: true,
    github_owner: b.githubOwner,
    github_repository: b.githubRepository,
  }))
    assert.deepEqual(plan.variables[name], { value });
  assert.ok(Array.isArray(plan.resource_changes));
  const targets = artifactIamTargets(b.environment),
    resources = new Map();
  const { closure } = artifactIamModelEvidence(plan, {
    ...options,
    environment: b.environment,
  });
  const identities = artifactIamDependencyIdentities(b);
  for (const r of plan.resource_changes) {
    assert.ok(!resources.has(r.address), "Duplicate artifact IAM address");
    resources.set(r.address, r);
    assert.equal(r.previous_address ?? null, null);
    assert.equal(r.change.importing ?? null, null);
    if (r.mode === "managed") {
      assert.ok(
        targets.has(r.address) || closure.has(r.address),
        "Outside artifact IAM dependency closure",
      );
      if (!targets.has(r.address)) {
        unchanged(r.change);
        checkDependencyIdentity(r, b, identities);
      }
    } else {
      assert.equal(r.mode, "data");
      checkMetadata(r, b);
    }
  }
  checkDependencies(resources, b);
  const check = (r) =>
    r.address === transcriptPolicy
      ? checkTranscript(r.change, b)
      : checkDeployment(r.change, b);
  for (const address of targets.keys()) {
    const r = resources.get(address);
    assert.equal(r?.mode, "managed");
    check(r);
  }
  return validateScopedPlan(plan, {
    targets,
    requiredNoOp: artifactIamObservationTargets(b.environment),
    check,
  });
}
module.exports = {
  artifactIamBinding,
  artifactIamTargets,
  validateArtifactIamPlan,
};
