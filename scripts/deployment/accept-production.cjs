"use strict";
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual: same } = require("node:util");
const { appendFileSync } = require("node:fs");
const collector = require("./production-acceptance-collector.cjs");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
const { createProductionAws } = require("./production-aws.cjs");
const pendingAcknowledgments = new WeakMap();
const now = () => Math.floor(Date.now() / 1000);
function refuse() {
  throw Error("acceptance_dispatch_or_recovery_required");
}
function actionRecord(value, requestHash) {
  const { f, history, stage } = value,
    { binding, hold } = f,
    a = stage.action,
    previous = stage.rows.at(-1);
  return {
    pk: history.authority.pk,
    sk: `ACTION#${a.actionId}`,
    recordType: "introduction_action",
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    manifestHash: binding.manifestHash,
    operationId: history.authority.operationId,
    revision: 1,
    actor: binding.actor,
    runToken: history.authority.runToken,
    actionId: a.actionId,
    kind: "acceptance_write",
    intentHash: history.authority.actions[a.actionId].intentHash,
    requestHash,
    predecessor: previous
      ? {
          actionId: previous.actionId,
          receiptHash: previous.observation.evidenceHash,
        }
      : null,
    reservedAt: now(),
    phase: "reserved",
    version: 1,
  };
}
async function acknowledgeAcceptance(token) {
  const retained = pendingAcknowledgments.get(token);
  if (!retained) refuse();
  const b = require("../../dist/services/productionAcceptanceTransactions.js");
  // Do not recheck expiry here: this write only retains the already received direct ACK.
  await retained.provider.write(
    b.buildFinalJournalWrite({
      table: retained.input.table,
      hold: retained.nextState.hold,
      authority: retained.input.authority,
      previous: retained.submitted,
      next: retained.acknowledged,
      now: now(),
    }),
  );
  pendingAcknowledgments.delete(token);
  return retained.acknowledged.actionId;
}
async function dispatchAcceptance(token) {
  const value = collector.readAcceptance(token);
  if (value.preparation || !value.stage) refuse();
  const b = require("../../dist/services/productionAcceptanceTransactions.js"),
    provider = createProductionAws(value.f.binding);
  const provisional = actionRecord(value, "0".repeat(64));
  const submittedShape = {
    ...provisional,
    phase: "submitted",
    version: 2,
    attemptId: randomUUID(),
    submittedAt: now(),
  };
  const shape = collector.transactionInputs(token, submittedShape);
  // The request identity binds the fixed recipe's complete inputs; the action's own hash is excluded to avoid a self-reference.
  const { action: _action, now: _now, ...requestIdentity } = shape;
  const reserved = {
    ...provisional,
    requestHash: canonicalHash(requestIdentity),
  };
  const submitted = { ...submittedShape, requestHash: reserved.requestHash };
  const input = collector.transactionInputs(token, submitted);
  b.buildFinalAcceptanceTransaction(input); // Capacity refusal precedes reserved/submitted persistence.
  const journal = (previous, next, hold = value.f.hold) =>
    provider.write(
      b.buildFinalJournalWrite({
        table: input.table,
        hold,
        authority: input.authority,
        previous,
        next,
        now: now(),
      }),
    );
  await journal(undefined, reserved);
  await journal(reserved, submitted);
  const actualHold = await provider.read({ pk: "ENV", sk: "INTRODUCTION" });
  const actualControl = await provider.read({ pk: "ENV", sk: "CONTROL" });
  const actualAuthority = await provider.read({
    pk: input.authority.pk,
    sk: input.authority.sk,
  });
  if (
    !same(actualHold, input.hold) ||
    !same(actualControl, input.control) ||
    !same(actualAuthority, input.authority)
  )
    refuse();
  const finalInput = collector.transactionInputs(token, submitted);
  const request = b.buildFinalAcceptanceTransaction(finalInput);
  assertBoundExecution(value.f.binding, now());
  const response = await provider.invoke("transactWriteItems", request, {
    maxAttempts: 1,
  });
  if (!response || response.UnprocessedItems) refuse();
  const nextState = b.finalState(finalInput);
  const facts = {
    kind: "acceptance_transition",
    purpose: value.stage.action.purpose,
    acceptanceId: value.acceptance.acceptanceId,
    ...(value.stage.action.purpose === "release_deployment"
      ? { restoration: value.launcher }
      : {}),
  };
  const acknowledgment = {
    resourceIds: [input.table],
    evidenceHash: canonicalHash({ request, directAcknowledgment: true }),
    facts,
  };
  const milliseconds = Date.now();
  const acknowledged = {
    ...submitted,
    phase: "acknowledged",
    version: 3,
    acknowledgment,
    acknowledgedAt: Math.floor(milliseconds / 1000),
    acknowledgedAtMilliseconds: milliseconds,
  };
  pendingAcknowledgments.set(token, {
    provider,
    input: finalInput,
    nextState,
    submitted,
    acknowledged,
  });
  await acknowledgeAcceptance(token);
  const hold = await provider.read({ pk: "ENV", sk: "INTRODUCTION" }),
    control = await provider.read({ pk: "ENV", sk: "CONTROL" });
  if (
    !same(hold, nextState.hold) ||
    !same(control, nextState.control) ||
    !same(
      await provider.read({ pk: value.acceptance.pk, sk: "ACCEPTANCE" }),
      value.acceptance,
    )
  )
    refuse();
  const observed = {
    ...acknowledged,
    phase: "observed",
    version: 4,
    observedAt: now(),
    observation: {
      resourceIds: [input.table],
      evidenceHash: canonicalHash({
        hold,
        control,
        acceptance: value.acceptance,
      }),
      facts,
    },
  };
  await journal(acknowledged, observed, nextState.hold);
  return value.stage.action.purpose;
}
async function runCli(output = console) {
  try {
    const mode = process.env.GITHUB_JOB;
    if (mode === "prepare-acceptance") {
      await require("./production-acceptance-supplement.cjs").waitForSupplementFromOriginalRun();
      const summary = collector.acceptanceSummary(
        await collector.waitForPreparedAcceptance(),
      );
      if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY)
        refuse();
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `supplement_commit=${summary.supplementCommit}\nsupplement_hash=${summary.supplementHash}\n`,
      );
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        [
          "Prepared fixture, writer, history and launcher evidence.",
          `Pinned supplement fingerprint: ${summary.supplementHash.slice(0, 16)}; commit fingerprint: ${summary.supplementCommit.slice(0, 12)}.`,
          ...summary.fixtureFingerprints.map(
            ({ index, fingerprint }) => `Fixture ${index}: ${fingerprint}.`,
          ),
          "Use the already declared private review location to compare these fingerprints. Fingerprints do not grant authority.",
          "Complete retained-work classification: UNVERIFIED. Final accept recollects it after approval; a blocker can extend the maintenance hold. Original expiry is unchanged.",
          "",
        ].join("\n"),
      );
      output.log(
        JSON.stringify({
          status: summary.status,
          retainedWorkClassification: summary.retainedWorkClassification,
        }),
      );
      return 0;
    }
    if (mode !== "accept") refuse();
    for (const purpose of [
      "persist_acceptance",
      "reopen_admission",
      "release_deployment",
    ]) {
      const token = await collector.collectAcceptanceFromOriginalRun();
      if (collector.readAcceptance(token).stage.action.purpose !== purpose)
        refuse();
      await dispatchAcceptance(token);
    }
    output.log(
      JSON.stringify({
        status: "accepted",
        admission: "reopened",
        deployment: "released",
        launcherMutations: 0,
      }),
    );
    return 0;
  } catch (error) {
    output.error(
      JSON.stringify({
        status: "refused",
        reason:
          error?.message === "acceptance_capacity_refused"
            ? "acceptance_capacity_refused"
            : "acceptance_prerequisite_or_recovery_required",
        admission: "preserve",
        deployment: "preserve",
      }),
    );
    return 1;
  }
}
module.exports = { runCli, dispatchAcceptance, acknowledgeAcceptance };
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
