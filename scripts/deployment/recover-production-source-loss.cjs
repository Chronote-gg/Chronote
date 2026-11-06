"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { recoverSourceLoss, runRecoveryCli } = require("./recover-sandbox.cjs");
const { awsCli } = require("./coordinator-aws.cjs");
const { bindingHash, continuationBinding } = require("./continue-sandbox.cjs");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const {
  eventEvidenceSchema,
  createServiceEventProof,
} = require("./service-event-stop-proof.cjs");
const flags = z
  .object({
    STRIPE_MODE: z.literal("live"),
    STRIPE_RENEWAL_GRACE_ENABLED: z.string(),
    STRIPE_INTRO_OFFER_LEDGER_ENABLED: z.string(),
    STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED: z.string(),
    STRIPE_RENEWAL_REACTIVATION_ENABLED: z.string(),
  })
  .strict();
const packetSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string().regex(/^\d{12}$/),
    actorArn: z.string().min(1),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    executorCommit: z.string().regex(/^[a-f0-9]{40}$/),
    operation: z.record(z.string(), z.unknown()),
    billingFlags: flags,
  })
  .strict();
async function recoverProduction(options = {}) {
  return recoverProductionEntry(options, false);
}
async function recoverEventProduction(options = {}) {
  return recoverProductionEntry(options, true);
}
async function closeoutProduction(options = {}) {
  return recoverProductionEntry(options, true, true);
}
const eventPacketSchema = packetSchema
  .extend({ eventEvidence: eventEvidenceSchema })
  .strict();
const closeoutPacketSchema = eventPacketSchema
  .extend({
    closeout: require("./historical-closeout-state.cjs").closeoutManifestSchema,
  })
  .strict();
async function recoverProductionEntry(options, eventMode, closeout = false) {
  const packet = (
      closeout
        ? closeoutPacketSchema
        : eventMode
          ? eventPacketSchema
          : packetSchema
    ).parse(options.packet),
    p = packet.operation,
    d = p.deployment;
  const env = { ...(options.env ?? process.env) };
  assert(
    !Object.keys(env).some((k) => k.startsWith("AWS_ENDPOINT_URL") && env[k]),
  );
  assert(
    ["inspect", "apply", ...(closeout ? ["observe"] : [])].includes(
      options.mode,
    ),
  );
  if (options.mode === "apply" || options.mode === "observe")
    assert.equal(bindingHash(packet), options.packetSha256);
  const rawAws =
    options.aws ??
    ((service, operation, input) =>
      awsCli(service, operation, input, {
        region: packet.region,
        maxAttempts: 1,
      }));
  const table = d.tablePrefix + "DeploymentControlTable";
  const holdKey = marshall({ pk: "ENV", sk: "INTRODUCTION" });
  async function checkHold() {
    const r = await rawAws("dynamodb", "get-item", {
      TableName: table,
      Key: holdKey,
      ConsistentRead: true,
    });
    assert(
      !r.Item || unmarshall(r.Item).deployment?.state === "released",
      "Production introduction holds deployment",
    );
  }
  async function aws(service, operation, input) {
    if (closeout) {
      require("./historical-closeout-state.cjs").assertCloseoutOperation(
        service,
        operation,
        options.mode,
      );
    } else if (service === "dynamodb" && operation === "transact-write-items") {
      assert.equal(options.mode, "apply");
      input = {
        ...input,
        TransactItems: [
          ...input.TransactItems,
          {
            ConditionCheck: {
              TableName: table,
              Key: holdKey,
              ConditionExpression:
                "attribute_not_exists(pk) OR deployment.#state = :released",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: marshall({ ":released": "released" }),
            },
          },
        ],
      };
    } else if (service === "elbv2" && operation === "modify-listener") {
      assert.equal(options.mode, "apply");
      await checkHold();
    } else
      assert(
        /^(get-|describe-|list-|query$|scan$)/.test(operation),
        "Operation outside recovery",
      );
    return rawAws(service, operation, input);
  }
  const actor = await aws("sts", "get-caller-identity", {});
  assert.equal(actor.Account, packet.accountId);
  assert.equal(actor.Arn, packet.actorArn);
  assert(
    actor.Arn.startsWith(
      `arn:aws:sts::${packet.accountId}:assumed-role/AWSReservedSSO_AccountAdministrator_`,
    ),
  );
  assert.match(d.tablePrefix, /-prod-$/);
  for (const identity of [d.outgoing, p.candidateIdentity])
    assert(
      identity.taskArn.startsWith(
        `arn:aws:ecs:${packet.region}:${packet.accountId}:task/`,
      ),
    );
  await checkHold();
  Object.assign(env, {
    AWS_REGION: packet.region,
    SECRETS_PREFIX: d.tablePrefix.slice(0, -1),
    ECS_CLUSTER: d.cluster,
    ECS_SERVICE: d.service,
    ECS_TASK_FAMILY: d.family,
    DEPLOYMENT_RUN_TOKEN: d.runToken,
    DEPLOYMENT_CANDIDATE_ID: d.candidateId,
    CANDIDATE_IMAGE: d.image,
    DEPLOYMENT_LISTENER_ARN: d.routing.listenerArn,
    DEPLOYMENT_TARGET_GROUP_A: d.routing.sourceGroup,
    DEPLOYMENT_TARGET_GROUP_B: d.routing.candidateGroup,
    SOURCE_LOSS_BINDING_SHA256: options.bindingSha256,
  });
  if (closeout)
    return require("./historical-closeout.cjs").historicalCloseout({
      ...options,
      packet,
      env,
      aws,
    });
  return recoverSourceLoss({
    ...options,
    env,
    aws,
    actor,
    mode: options.mode === "apply" ? "recover" : "inspect",
    terminalProof: eventMode
      ? createServiceEventProof({
          packet,
          now: options.now ?? (() => Math.floor(Date.now() / 1000)),
        })
      : undefined,
    validateScope: (_env, ctl) =>
      assert.deepEqual(continuationBinding(ctl, ctl.deployment.candidate), p),
    inspectionPolicy: {
      operation: p,
      billingFlags: packet.billingFlags,
      kind: eventMode
        ? "production_service_event_source_loss"
        : "production_source_loss",
    },
  });
}
module.exports = {
  recoverProduction,
  recoverEventProduction,
  packetSchema,
  eventPacketSchema,
  closeoutPacketSchema,
  closeoutProduction,
};
if (require.main === module) {
  const fs = require("node:fs"),
    { execFileSync } = require("node:child_process");
  const [mode = "inspect", file, packetSha256, bindingSha256] =
    process.argv.slice(2);
  runRecoveryCli(
    async () => {
      const closeout = [
        "inspect-closeout",
        "apply-closeout",
        "observe-closeout",
      ].includes(mode);
      const eventMode = ["inspect-event", "apply-event"].includes(mode);
      const packet = (
        closeout
          ? closeoutPacketSchema
          : eventMode
            ? eventPacketSchema
            : packetSchema
      ).parse(JSON.parse(fs.readFileSync(file, "utf8")));
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim(),
        packet.executorCommit,
      );
      execFileSync("git", ["diff", "--quiet", "HEAD", "--"], {
        windowsHide: true,
      });
      const recover = closeout
        ? closeoutProduction
        : eventMode
          ? recoverEventProduction
          : recoverProduction;
      const action =
        {
          "inspect-event": "inspect",
          "apply-event": "apply",
          "inspect-closeout": "inspect",
          "apply-closeout": "apply",
          "observe-closeout": "observe",
        }[mode] ?? mode;
      return recover({ mode: action, packet, packetSha256, bindingSha256 });
    },
    mode,
    "production_source_loss_recovery_failed",
  );
}
