import {
  manifestFixture,
  phaseAuthorization,
} from "./productionIntroduction.js";
import { manifestHash } from "../../../scripts/deployment/sandbox-manifest.cjs";
import { buildMaintenancePolicy } from "../../../scripts/deployment/maintenance-fence.cjs";
export function rehearsalFixture() {
  const original = manifestFixture();
  const disposablePrefix = `cr-${original.binding.operationId.replaceAll("-", "").slice(0, 16)}-`;
  const m = JSON.parse(
    JSON.stringify(original).replaceAll("chronote-", disposablePrefix),
  );
  m.kind = "rehearsal-introduction";
  m.environment = "rehearsal";
  m.disposablePrefix = disposablePrefix;
  const { accountId, region, operationId } = m.binding;
  const ecs = `arn:aws:ecs:${region}:${accountId}:`;
  const elb = `arn:aws:elasticloadbalancing:${region}:${accountId}:`;
  m.listenerArn =
    elb +
    `listener/app/${disposablePrefix}lb/` +
    "1".repeat(16) +
    "/" +
    "2".repeat(16);
  m.targetGroupA = elb + `targetgroup/${disposablePrefix}a/` + "3".repeat(16);
  m.targetGroupB = elb + `targetgroup/${disposablePrefix}b/` + "4".repeat(16);
  m.ownedPolicyName = "chronote-maintenance-" + operationId;
  m.ownedPolicySha256 = manifestHash(buildMaintenancePolicy(m.binding));
  m.resourceEvidence = [
    m.binding.taskRoleArn,
    m.executionRoleArn,
    m.deploymentRoleArn,
    ...Object.values(m.binding.tableArns),
    ...[
      "controlTableArn",
      "legacyTaskArn",
      "legacyTaskDefinition",
      "taskDefinition",
      "fallbackTaskDefinition",
      "listenerArn",
      "targetGroupA",
      "targetGroupB",
    ].map((field) => m[field]),
    ecs + "cluster/" + m.cluster,
    ecs + "service/" + m.cluster + "/" + m.service,
    `arn:aws:s3:::${m.bucket}`,
    `arn:aws:ecr:${region}:${accountId}:repository/${m.imageRepository}`,
  ].map((arn) => ({
    arn,
    tags: {
      Environment: "rehearsal",
      OperationId: operationId,
      DisposablePrefix: disposablePrefix,
    },
  }));
  return m;
}
export function rehearsalAuthorization(m, phase = "fence") {
  const a = phaseAuthorization(m, phase);
  a.envelope.kind = "rehearsal-phase";
  a.envelope.principalArn = `arn:aws:sts::${m.binding.accountId}:assumed-role/${m.deploymentRoleArn.split("/").at(-1)}/chronote-rehearsal-${a.envelope.runId}-1`;
  a.expectedSha256 = a.bindSha256 = manifestHash(a.envelope);
  return a;
}
