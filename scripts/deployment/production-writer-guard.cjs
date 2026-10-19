"use strict";
const { z } = require("zod");
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { readFileSync } = require("node:fs");
const { awsCli } = require("./coordinator-aws.cjs");
const {
  validatePrerequisitePlan,
} = require("./validate-prerequisite-plan.cjs");
const { assertPlanProvenance } = require("./plan-provenance.cjs");
const receipts = new WeakSet();
const configSchema = z
  .object({
    environment: z.literal("production"),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    roleArn: z.string().min(1),
    table: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
function refuse() {
  throw new Error("production_writer_refused");
}
function assertPrerequisitePlan(plan, table) {
  validatePrerequisitePlan(plan);
  if (
    !plan.resource_changes.some(
      (r) =>
        r.address === "aws_dynamodb_table.deployment_control_table" &&
        r.mode === "managed" &&
        r.change.actions.length === 1 &&
        r.change.actions[0] === "create" &&
        r.change.after?.name === table,
    )
  )
    refuse();
}
function prerequisiteReceipt({
  config,
  plan,
  provenance,
  bytes,
  expected,
  producingRun,
}) {
  const p = assertPlanProvenance({ provenance, bytes, expected, producingRun });
  if (
    p.environment !== "production" ||
    p.workspace !== "default" ||
    p.scope !== "deployment-prerequisites"
  )
    refuse();
  assertPrerequisitePlan(plan, config.table);
  const receipt = {
    table: config.table,
    accountId: config.accountId,
    region: config.region,
  };
  receipts.add(receipt);
  return receipt;
}
function assertCaller(config, caller) {
  configSchema.parse(config);
  const prefix = `arn:aws:iam::${config.accountId}:role/`;
  if (
    !config.roleArn.startsWith(prefix) ||
    caller.Account !== config.accountId ||
    !caller.Arn?.startsWith(
      `arn:aws:sts::${config.accountId}:assumed-role/${config.roleArn.slice(prefix.length)}/`,
    )
  )
    refuse();
}
async function assertNormalWriter({
  config,
  caller,
  read,
  prerequisite,
  types,
}) {
  assertCaller(config, caller);
  let hold;
  try {
    hold = await read({ pk: "ENV", sk: "INTRODUCTION" });
  } catch (error) {
    if (
      error.name === "ResourceNotFoundException" &&
      receipts.has(prerequisite) &&
      ["table", "accountId", "region"].every(
        (k) => prerequisite[k] === config[k],
      )
    )
      return { status: "allowed_prerequisite" };
    return refuse();
  }
  if (hold === undefined) return { status: "allowed" };
  const parsed = (
    types ?? require("../../dist/types/productionIntroduction.js")
  ).introductionHoldSchema.parse(hold);
  if (parsed.deployment.state !== "released") refuse();
  return { status: "allowed" };
}
function guardConfiguration(env) {
  if (Object.keys(env).some((k) => k.startsWith("AWS_ENDPOINT_URL") && env[k]))
    refuse();
  return configSchema.parse({
    environment: env.DEPLOYMENT_ENVIRONMENT,
    accountId: env.DEPLOYMENT_ACCOUNT_ID,
    region: env.AWS_REGION,
    roleArn: env.DEPLOYMENT_GUARD_ROLE_ARN,
    table: env.DEPLOYMENT_CONTROL_TABLE,
  });
}
async function runGuard(env = process.env, inspectOnly = false) {
  const config = guardConfiguration(env);
  const caller = await awsCli("sts", "get-caller-identity", {});
  const client = new DynamoDBClient({ region: config.region });
  let prerequisite;
  if (env.PREREQUISITE_PLAN_JSON) {
    const input = {
      config,
      plan: JSON.parse(readFileSync(env.PREREQUISITE_PLAN_JSON, "utf8")),
      provenance: JSON.parse(
        readFileSync("_infra/plan-artifact/plan-provenance.json", "utf8"),
      ),
      bytes: readFileSync("_infra/tfplan"),
      producingRun: JSON.parse(readFileSync("_infra/plan-run.json", "utf8")),
      expected: {
        repository: env.GITHUB_REPOSITORY,
        source: env.GITHUB_SHA,
        ref: env.GITHUB_REF,
        runId: env.PLAN_RUN_ID,
        artifact: env.ARTIFACT_NAME,
        planHash: env.EXPECTED_SHA256,
        environment: "production",
        workspace: "default",
      },
    };
    const provenance = assertPlanProvenance(input);
    if (provenance.scope === "deployment-prerequisites")
      prerequisite = prerequisiteReceipt(input);
  }
  if (inspectOnly) {
    assertCaller(config, caller);
    try {
      await client.send(
        new GetItemCommand({
          TableName: config.table,
          Key: marshall({ pk: "ENV", sk: "INTRODUCTION" }),
          ConsistentRead: true,
        }),
      );
    } catch (error) {
      if (error.name === "ResourceNotFoundException")
        return { status: "prerequisite_required", mutationAuthorized: false };
      throw error;
    }
  }
  return assertNormalWriter({
    config,
    caller,
    prerequisite,
    read: async (key) => {
      const result = await client.send(
        new GetItemCommand({
          TableName: config.table,
          Key: marshall(key),
          ConsistentRead: true,
        }),
      );
      return result.Item ? unmarshall(result.Item) : undefined;
    },
  });
}
if (require.main === module)
  runGuard(process.env, process.argv[2] === "--inspect")
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(() => {
      process.stderr.write(
        '{"status":"refused","reason":"production_writer_refused"}\n',
      );
      process.exitCode = 1;
    });
module.exports = {
  assertNormalWriter,
  assertCaller,
  assertPrerequisitePlan,
  prerequisiteReceipt,
  guardConfiguration,
  runGuard,
};
