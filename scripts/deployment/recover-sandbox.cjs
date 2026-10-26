"use strict";
const assert = require("node:assert/strict");
const { awsCli, configuration } = require("./coordinator.cjs");
const { assertSandboxIdentity } = require("./assert-sandbox-identity.cjs");
const {
  assertSandboxScope,
  bindingHash,
  continuationBinding,
} = require("./continue-sandbox.cjs");
const { unmarshall, marshall } = require("@aws-sdk/util-dynamodb");
const {
  createSourceLossInspection,
  sourceLossBinding,
} = require("./source-loss-inspection.cjs");
const { inspectObligations } = require("./source-loss-obligations.cjs");
const {
  controlUpdate,
  receiptWrite,
  initialReceipt,
  promotion,
  candidateCheck,
  writeState,
} = require("./source-loss-state.cjs");
async function recoverSandbox(options = {}) {
  const env = options.env ?? process.env;
  assert.ok(
    !Object.keys(env).some(
      (key) => key.startsWith("AWS_ENDPOINT_URL") && env[key],
    ),
  );
  assert.ok(["inspect", "recover"].includes(options.mode));
  const aws = options.aws ?? awsCli;
  const actor = await aws("sts", "get-caller-identity", {});
  assertSandboxIdentity(actor, env);
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  const builders =
    options.builders ??
    require("../../dist/services/deploymentControlTransactions.js");
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const table = `${env.SECRETS_PREFIX}-DeploymentControlTable`;
  const response = await aws("dynamodb", "get-item", {
    TableName: table,
    Key: marshall({ pk: "ENV", sk: "CONTROL" }),
    ConsistentRead: true,
  });
  const original = types.controlRecordSchema.parse(unmarshall(response.Item));
  (options.validateScope ?? assertSandboxScope)(env, original);
  const d = original.deployment;
  const config = configuration({
    ...env,
    DEPLOYMENT_RUN_TOKEN: d.runToken,
    DEPLOYMENT_CANDIDATE_ID: d.candidateId,
    CANDIDATE_IMAGE: d.image,
  });
  const inspector = createSourceLossInspection({
    aws,
    config,
    env,
    types,
    now,
    terminalProof: options.terminalProof,
  });
  const observed = await inspector.inspect();
  assert.equal(
    bindingHash(continuationBinding(original, observed.candidateIdentity)),
    bindingHash(
      continuationBinding(observed.control, observed.candidateIdentity),
    ),
  );
  const obligations = await inspectObligations({
    aws,
    tablePrefix: config.tablePrefix,
    source: d.outgoing,
    now,
  });
  const binding = sourceLossBinding(
    observed.control,
    observed.candidateIdentity,
    observed.terminal,
  );
  const hash = bindingHash(binding);
  if (options.mode === "inspect")
    return { kind: "inspection", bindingSha256: hash, binding, obligations };
  assert.match(env.SOURCE_LOSS_BINDING_SHA256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(hash, env.SOURCE_LOSS_BINDING_SHA256);
  // Revalidate outside uncertain-write handling: a refusal can never be swallowed as an applied write.
  const fresh = await inspector.inspect();
  assert.equal(
    bindingHash(
      sourceLossBinding(fresh.control, fresh.candidateIdentity, fresh.terminal),
    ),
    hash,
  );
  let ctl = fresh.control;
  const candidate = fresh.candidateIdentity;
  const admittedAt = now();
  let receipt = initialReceipt({
    d,
    candidate,
    terminal: fresh.terminal,
    admittedAt,
    actorArn: actor.Arn,
    bindingSha256: hash,
    metadataAudit: obligations,
  });
  let next = {
    ...ctl,
    coordinatorExpiresAt: admittedAt + 180,
    servingGeneration: ctl.servingGeneration + 1,
    servingMembers: { [candidate.instanceId]: candidate },
    deployment: {
      ...ctl.deployment,
      phase: "promoting",
      candidate,
      routing: {
        ...ctl.deployment.routing,
        candidateRevision: fresh.terminal.candidateRevision,
      },
      updatedAt: admittedAt,
    },
  };
  ctl = await writeState({
    aws,
    table,
    inspector,
    types,
    next,
    receipt,
    transaction: promotion({
      builders,
      table,
      ctl,
      next,
      candidate,
      receipt,
      now: admittedAt,
    }),
  });
  async function readAuthority(expected) {
    const current = await inspector.control();
    assert.deepEqual(await inspector.read(receipt.pk, receipt.sk), receipt);
    const row = await inspector.runtime(candidate);
    for (const key of [
      "coordinatorToken",
      "coordinatorEpoch",
      "servingGeneration",
      "servingMembers",
      "deployment",
    ])
      assert.deepEqual(current[key], expected[key]);
    assert.ok(current.coordinatorExpiresAt > now());
    assert.equal(row.role, "serving");
    assert.equal(row.authorizedGeneration, current.servingGeneration);
    assert.ok(!row.retirementRequest && !row.retirementAcknowledgment);
    assert.ok(inspector.proof.ready(row, current, candidate, d.runtimeMode));
    assert.ok(
      row.heartbeatAt > admittedAt && row.readiness.provenAt > admittedAt,
    );
    return current;
  }
  async function authority(expected, requireSourceAction = false) {
    const current = await readAuthority(expected);
    const native = await inspector.native(current, candidate);
    if (requireSourceAction)
      await inspector.routing.assertAction(current.deployment.routing, false);
    await readAuthority(expected);
    assert.ok(native.nativeProtectionExpiresAt > now() + 120);
  }
  let refreshed = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const row = await inspector.runtime(candidate);
    if (
      row.heartbeatAt > admittedAt &&
      row.readiness.provenAt > admittedAt &&
      inspector.proof.ready(row, ctl, candidate, d.runtimeMode)
    ) {
      refreshed = true;
      break;
    }
    await sleep(1000);
  }
  assert.ok(
    refreshed,
    "Candidate readiness did not refresh after admission; preserve recovery receipt",
  );
  async function persist(previous, routing) {
    await authority(previous, routing.state === "forward_submitted");
    const timestamp = now();
    next = {
      ...previous,
      coordinatorExpiresAt: timestamp + 180,
      deployment: {
        ...previous.deployment,
        routing,
        phase: routing.state === "candidate" ? "promoted" : "promoting",
        updatedAt: timestamp,
      },
    };
    const updated = {
      ...receipt,
      stage:
        routing.state === "candidate"
          ? "availability_restored"
          : "forward_submitted",
      updatedAt: timestamp,
    };
    const result = await writeState({
      aws,
      table,
      inspector,
      types,
      next,
      receipt: updated,
      transaction: {
        TransactItems: [
          controlUpdate(table, previous, next),
          receiptWrite(table, receipt, updated),
          candidateCheck({
            builders,
            table,
            ctl: previous,
            candidate,
            admittedAt,
            now: timestamp,
          }),
        ],
      },
    });
    receipt = updated;
    return result;
  }
  ctl = await inspector.routing.switchTraffic(ctl, true, persist, (current) =>
    authority(current, true),
  );
  await authority(ctl);
  await inspector.routing.assertAction(ctl.deployment.routing, true);
  return {
    kind: "availability_restored",
    settlement: receipt.settlement,
    bindingSha256: hash,
  };
}
function runRecoveryCli(recover, mode, failureKind) {
  return recover({ mode })
    .then((result) =>
      console.log(
        JSON.stringify({
          kind: result.kind,
          settlement: result.settlement,
          bindingSha256: result.bindingSha256,
        }),
      ),
    )
    .catch(() => {
      console.error(
        JSON.stringify({
          kind: failureKind,
          action: "preserve_receipts_and_review_current_state",
        }),
      );
      process.exitCode = 1;
    });
}
module.exports = { recoverSandbox, runRecoveryCli };
if (require.main === module)
  runRecoveryCli(
    recoverSandbox,
    process.argv[2],
    "source_loss_recovery_failed",
  );
