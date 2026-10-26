"use strict";
const { isDeepStrictEqual: same } = require("node:util");
function assertPreparedCandidate(m, d) {
  const container = d.containerDefinitions.find(
    (v) => v.name === m.containerName,
  );
  if (
    d.taskDefinitionArn !== m.taskDefinition ||
    d.status !== "ACTIVE" ||
    !container ||
    !container.image.endsWith("@" + m.imageDigest) ||
    container.stopTimeout !== 120 ||
    container.secrets?.some((v) =>
      [
        "TRANSCRIPTS_BUCKET",
        "DDB_TABLE_PREFIX",
        "DEPLOYMENT_CANDIDATE_ID",
      ].includes(v.name),
    ) ||
    container.entryPoint?.length ||
    !same(container.command, candidateCommand(m.runtimeMode)) ||
    !preparedEnvironmentMatches(m, container.environment)
  )
    throw new Error("Prepared candidate definition mismatch");
}
function candidateCommand(runtimeMode) {
  return {
    all: ["node", "dist/index.js"],
    bot: ["node", "dist/apps/bot/main.js"],
    api: ["node", "dist/apps/api/main.js"],
  }[runtimeMode];
}
function preparedEnvironmentMatches(m, environment) {
  const expected = {
    TRANSCRIPTS_BUCKET: m.bucket,
    DDB_TABLE_PREFIX: m.tablePrefix,
    DEPLOYMENT_CANDIDATE_ID: m.operationId,
  };
  return Object.entries(expected).every(([name, value]) => {
    const entries = environment.filter((entry) => entry.name === name);
    return entries.length === 1 && entries[0].value === value;
  });
}
function targetGroupBindingMatches(m, group, listener, beforeIntroduction) {
  if (beforeIntroduction && group.TargetGroupArn === m.targetGroupB)
    return group.LoadBalancerArns?.length === 0;
  return group.LoadBalancerArns?.includes(listener.LoadBalancerArn);
}
function assertTargetGroupConfiguration(m, group, vpc) {
  if (
    ![m.targetGroupA, m.targetGroupB].includes(group.TargetGroupArn) ||
    group.TargetType !== "ip" ||
    group.Protocol !== "HTTP" ||
    group.Port !== m.containerPort ||
    group.HealthCheckPath !== "/health" ||
    !group.VpcId ||
    (vpc && vpc !== group.VpcId)
  )
    throw new Error("Group configuration mismatch");
}
async function assertTargetGroups(
  m,
  aws,
  listener,
  beforeIntroduction = false,
) {
  const groups = await aws("elbv2", "describe-target-groups", {
    TargetGroupArns: [m.targetGroupA, m.targetGroupB],
  });
  if (
    groups.TargetGroups.length !== 2 ||
    new Set(groups.TargetGroups.map((g) => g.TargetGroupArn)).size !== 2
  )
    throw new Error("Group identities incomplete");
  let vpc;
  for (const g of groups.TargetGroups) {
    assertTargetGroupConfiguration(m, g, vpc);
    if (!targetGroupBindingMatches(m, g, listener, beforeIntroduction))
      throw new Error("Group configuration mismatch");
    vpc = g.VpcId;
    const attrs = await aws("elbv2", "describe-target-group-attributes", {
      TargetGroupArn: g.TargetGroupArn,
    });
    if (
      attrs.Attributes.find((a) => a.Key === "stickiness.enabled")?.Value !==
      "false"
    )
      throw new Error("Sticky target group");
  }
}

function initialControl(operationId, expiresAt) {
  return {
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "ecs",
    protocolVersion: 1,
    coordinatorToken: operationId,
    coordinatorEpoch: 1,
    coordinatorExpiresAt: expiresAt,
    servingGeneration: 0,
    servingMembers: {},
  };
}
module.exports = {
  assertPreparedCandidate,
  assertTargetGroups,
  initialControl,
};
