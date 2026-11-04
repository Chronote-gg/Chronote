"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const {
  verifySource,
  verifyChecks,
  excludedChecks,
  closure: meetingClosure,
} = require("./terraform-meeting-model.cjs");

const tables = [
  "active_meeting",
  "deployment_control",
  "meeting_control_command",
  "meeting_history",
  "personal_media_upload_job",
  "personal_recording_segment",
];
const secrets = [
  "discord_bot_token",
  "discord_client_secret",
  "langfuse_public_key",
  "langfuse_secret_key",
  "oauth_secret",
  "openai_api_key",
  "stripe_secret_key",
  "stripe_webhook_secret",
];
function artifactIamObservationTargets(environment) {
  return [
    "aws_iam_role.ecs_task_app_role",
    "aws_iam_role.ecs_task_execution_role",
    `aws_iam_role.${environment === "sandbox" ? "sandbox" : "production"}_deploy[0]`,
    "aws_iam_role_policy_attachment.ecs_task_transcripts_policy",
    "aws_iam_role_policy_attachment.ecs_task_exec_transcripts_policy",
    "aws_s3_bucket_server_side_encryption_configuration.transcripts",
    "aws_s3_bucket_versioning.transcripts",
    "aws_dynamodb_table.meeting_history_table",
    "aws_kms_key.app_general",
    "aws_s3_bucket.transcripts",
  ];
}
function artifactIamClosure(environment) {
  assert.ok(["sandbox", "production"].includes(environment));
  return new Set([
    ...artifactIamObservationTargets(environment),
    "aws_ecs_cluster.main",
    ...secrets.map((name) => `aws_secretsmanager_secret.${name}`),
    ...(environment === "sandbox"
      ? [
          "aws_ecr_repository.app_ecr_repo",
          ...tables.map((name) => `aws_dynamodb_table.${name}_table`),
        ]
      : meetingClosure),
  ]);
}
function artifactIamModelEvidence(plan, { directory, sourceSha, environment }) {
  const requiredPass = [
    `aws_iam_role.${environment === "sandbox" ? "sandbox" : "production"}_deploy`,
    "var.ENABLE_API_ALB",
  ];
  const checks = plan.checks ?? [];
  assert.ok(Array.isArray(checks));
  for (const check of checks) {
    const declared = excludedChecks.find(
      (c) => c.to_display === check.address?.to_display,
    );
    assert.ok(declared, "Undeclared artifact IAM check");
    assert.deepEqual(check.address, declared);
  }
  for (const name of requiredPass)
    assert.ok(
      checks.some((c) => c.address?.to_display === name && c.status === "pass"),
      "Missing required artifact IAM check",
    );
  let proof;
  if (checks.some((c) => c.status === "unknown")) {
    assert.ok(directory, "Source evidence required for unknown checks");
    const sha =
      sourceSha ??
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: directory,
        windowsHide: true,
      })
        .toString()
        .trim();
    proof = verifySource(directory, sha);
    assert.deepEqual(
      checks.map((c) => c.address.to_display).sort(),
      excludedChecks.map((c) => c.to_display).sort(),
      "Incomplete artifact IAM check catalog",
    );
  }
  verifyChecks(plan, proof, requiredPass);
  for (const check of checks) {
    if (check.status !== "pass") continue;
    const name = check.address.to_display;
    const expected =
      check.address.kind === "var"
        ? [name]
        : plan.resource_changes
            .filter(
              (r) => r.address === name || r.address.startsWith(`${name}[`),
            )
            .map((r) => r.address);
    assert.deepEqual(
      (check.instances ?? []).map((i) => i.address.to_display).sort(),
      expected.sort(),
      "Unbound artifact IAM check instances",
    );
  }
  return { closure: artifactIamClosure(environment) };
}
module.exports = {
  artifactIamObservationTargets,
  artifactIamClosure,
  artifactIamModelEvidence,
};
