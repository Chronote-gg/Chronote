"use strict";
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { isDeepStrictEqual } = require("node:util");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");

function createArtifactHandoff(options) {
  const {
    aws,
    tables,
    now,
    runtime,
    control,
    renew,
    protectedTask,
    sleep,
    production,
  } = options;
  const types =
    options.artifactTypes ?? require("../../dist/types/artifactSafety.js");
  const builders =
    options.artifactBuilders ??
    require("../../dist/services/artifactSafetyTransactions.js");
  const legacy =
    options.legacyArtifactBuilders ??
    require("../../dist/services/legacyArtifactAttestation.js");
  const same = isDeepStrictEqual;
  function refuse(message) {
    throw new CoordinatorFailure("artifact_preservation_unconfirmed", message);
  }
  async function lookup(identity) {
    const result = await aws("dynamodb", "get-item", {
      TableName: tables.deploymentControl,
      Key: marshall(types.artifactSafetyKey(identity)),
      ConsistentRead: true,
    });
    if (!result.Item) return undefined;
    const parsed = types.artifactSafetyRecordSchema.safeParse(
      unmarshall(result.Item),
    );
    if (!parsed.success || !same(parsed.data.identity, identity))
      refuse("Artifact capability is missing or unsupported");
    return parsed.data;
  }
  async function read(identity) {
    return (
      (await lookup(identity)) ??
      refuse("Artifact capability is missing or unsupported")
    );
  }
  const attested = require("./legacy-attestation.cjs").createLegacyAttestation({
    ...options,
    aws,
    tables,
    now,
    types,
    legacy,
    runtime,
    control,
    lookup,
  });
  /** Liveness the coordinator vouches for after checking the legacy runtime row. */
  function live() {
    const heartbeatAt = now();
    return {
      heartbeatAt,
      freshUntil: heartbeatAt + types.ARTIFACT_PROOF_SECONDS,
    };
  }
  function binding(row, ctl) {
    const d = ctl.deployment;
    if (
      !d ||
      !("request" in row) ||
      !same(row.identity, d.outgoing) ||
      row.request.coordinatorToken !== ctl.coordinatorToken ||
      row.request.coordinatorEpoch !== ctl.coordinatorEpoch ||
      row.request.servingGeneration !== d.originalGeneration
    )
      refuse("Artifact handoff authority changed");
  }
  function base(row) {
    return {
      ...types.artifactSafetyBaseSchema.parse(row),
      revision: row.revision + 1,
    };
  }
  async function write(purpose, expected, next, ctl) {
    if (production)
      refuse("Private recovery recipe does not support artifact safety writes");
    const source = await runtime(next.identity);
    const input = {
      purpose,
      expected,
      next,
      context: { kind: "preparing", control: ctl, runtime: source },
      now: now(),
    };
    const transaction = next.attestation
      ? legacy.buildLegacyArtifactTransaction(
          {
            purpose,
            expected,
            next,
            runtime: source,
            control: ctl,
            now: input.now,
          },
          tables,
        )
      : builders.buildArtifactSafetyTransaction(input, tables);
    const phase = {
      consume: "warming",
      cancel: next.attestation && "complete",
    }[purpose];
    try {
      await aws("dynamodb", "transact-write-items", transaction);
    } catch (error) {
      const observed = await read(next.identity);
      if (!isDeepStrictEqual(observed, next)) throw error;
      if (
        phase &&
        !isDeepStrictEqual(
          await control(),
          builders.artifactPreparationControl(ctl, input.now, phase),
        )
      )
        throw error;
    }
    return read(next.identity);
  }
  async function committed(ctl) {
    const row = await read(ctl.deployment.outgoing);
    binding(row, ctl);
    if (
      row.state !== "consumed" ||
      row.consumedAt < row.proof.provenAt ||
      row.consumedAt >= row.proof.expiresAt
    )
      refuse("Historical preservation commitment is missing");
    return row;
  }
  async function sourceEvidence(ctl) {
    try {
      const row = await committed(ctl);
      return row.attestation
        ? "operator_attested_legacy"
        : "verified_at_launch";
    } catch {
      return "UNKNOWN";
    }
  }
  async function request(ctl, row) {
    if (production)
      refuse(
        "Private recovery recipe requires a reviewed artifact safety upgrade",
      );
    const protection = await protectedTask(row.identity);
    const expiresAt = Math.min(
      now() + types.ARTIFACT_PREPARATION_SECONDS,
      Math.floor(Date.parse(protection.expirationDate) / 1000) - 120,
    );
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now())
      refuse("Native protection cannot cover preservation");
    if (row.attestation && row.attestation.expiresAt <= now())
      refuse("Legacy preservation attestation expired; attest again");
    return write(
      "request",
      row,
      {
        ...base(row),
        ...(row.attestation ? live() : {}),
        state: "requested",
        request: {
          source: row.identity,
          coordinatorToken: ctl.coordinatorToken,
          coordinatorEpoch: ctl.coordinatorEpoch,
          servingGeneration: ctl.servingGeneration,
          requestedAt: now(),
          expiresAt,
        },
      },
      ctl,
    );
  }
  async function prepare(ctl) {
    if (ctl.deployment.phase !== "preparing") {
      await committed(ctl);
      return ctl;
    }
    let row = await read(ctl.deployment.outgoing);
    if (["idle", "cancelled", "attested_legacy"].includes(row.state))
      row = await request(ctl, row);
    binding(row, ctl);
    row = await sealAttested(ctl, row);
    for (;;) {
      if (row.request.expiresAt <= now() || row.freshUntil <= now())
        refuse("Artifact preparation expired; admission remains sealed");
      if (!["requested", "draining", "sealed"].includes(row.state))
        refuse("Artifact preservation is blocked; admission remains sealed");
      ctl = await renew(ctl);
      await protectedTask(row.identity);
      if (row.state === "sealed") {
        await write(
          "consume",
          row,
          {
            ...row,
            revision: row.revision + 1,
            state: "consumed",
            consumedAt: now(),
          },
          ctl,
        );
        const observed = await control();
        if (observed.deployment?.phase !== "warming")
          refuse("Atomic warming acknowledgment missing");
        await committed(observed);
        return observed;
      }
      await sleep(5000);
      ctl = await control();
      row = await read(row.identity);
      binding(row, ctl);
    }
  }
  /** Stands in for the legacy runtime's seal while the staleness guard still holds. */
  async function sealAttested(ctl, row) {
    if (row.state !== "requested" || !row.attestation) return row;
    await attested.guard(row.identity, row.attestation.capturedAt);
    const { heartbeatAt, freshUntil } = live();
    const proof = {
      snapshot: legacy.legacyAttestedSnapshot(row.attestation),
      provenAt: heartbeatAt,
      expiresAt: Math.min(
        freshUntil,
        row.request.expiresAt,
        row.attestation.expiresAt,
      ),
    };
    return write(
      "seal",
      row,
      {
        ...row,
        revision: row.revision + 1,
        heartbeatAt,
        freshUntil,
        state: "sealed",
        proof,
      },
      ctl,
    );
  }
  async function candidate(identity) {
    const row = await read(identity);
    if (
      row.state !== "idle" ||
      row.startup.kind !== "sealed" ||
      row.freshUntil <= now() ||
      row.startup.proof.provenAt > now() ||
      row.startup.proof.expiresAt <= now() + 20
    )
      refuse("Candidate startup preservation proof is unavailable");
    return row;
  }
  function condition(row, proof) {
    const check = {
      TableName: tables.deploymentControl,
      Key: marshall(types.artifactSafetyKey(row.identity)),
      ...builders.artifactSnapshotCondition(
        builders.artifactExpectedAttributes(row),
      ),
    };
    if (proof) {
      check.ConditionExpression +=
        " AND freshUntil > :artifactNow AND startup.proof.expiresAt > :artifactDeadline";
      check.ExpressionAttributeValues = {
        ...check.ExpressionAttributeValues,
        ...marshall({ ":artifactNow": now(), ":artifactDeadline": now() + 20 }),
      };
    }
    return { ConditionCheck: check };
  }
  async function promotionChecks(ctl, identity) {
    if (production)
      refuse("Private promotion recipe requires an artifact safety upgrade");
    const source = await committed(ctl);
    const target = await candidate(identity);
    const checks = [condition(source), condition(target, true)];
    for (const authority of target.startup.proof.snapshot.authorities)
      checks.push({
        ConditionCheck: {
          TableName: tables.meetingHistory,
          Key: marshall({
            guildId: authority.owner.guildId,
            channelId_timestamp: authority.historyKey,
          }),
          ...builders.artifactSnapshotCondition(
            builders.artifactHistoryAttributes(authority),
          ),
        },
      });
    return checks;
  }
  async function cancel(ctl) {
    if (ctl.deployment?.phase !== "preparing")
      refuse("Warming may have launched; cancellation refused");
    const row = await read(ctl.deployment.outgoing);
    binding(row, ctl);
    await protectedTask(row.identity);
    return write(
      "cancel",
      row,
      { ...base(row), state: "cancel_requested", request: row.request },
      ctl,
    );
  }
  /**
   * A legacy source never sealed admission, so nothing waits on it: the
   * coordinator returns the row to its attested state and Control to
   * `complete` in one transaction, as a runtime acknowledgment would.
   */
  async function cancelAttested(ctl, row) {
    if (ctl.deployment.phase !== "preparing")
      refuse("Warming may have launched; cancellation refused");
    if ("request" in row) binding(row, ctl);
    const definition = ctl.deployment.taskDefinition;
    if ((await options.tasks()).some((t) => t.taskDefinitionArn === definition))
      refuse("A candidate task exists; cancellation refused");
    ctl = await renew(ctl);
    await write(
      "cancel",
      row,
      { ...base(row), ...live(), state: "attested_legacy" },
      ctl,
    );
    if ((await control()).deployment?.phase !== "complete")
      refuse("Cancellation acknowledgment missing");
    return { kind: "cancelled" };
  }
  async function cancelPreparation() {
    await options.assertWriter();
    const ctl = await control();
    options.own(ctl);
    const svc = await options.service();
    if (svc.taskDefinition !== ctl.deployment?.previousTaskDefinition)
      refuse("Service may already have launched; cancellation refused");
    const row = await lookup(ctl.deployment.outgoing);
    if (row?.attestation) return cancelAttested(ctl, row);
    await cancel(ctl);
    return { kind: "cancellation_requested" };
  }
  async function promote(ctl, promotion, retained, transactPromotion) {
    const checks = await promotionChecks(ctl, promotion.candidate);
    const transaction = options.builders.buildPromotionTransaction({
      ...promotion,
      tables,
    });
    transaction.TransactItems.push(...checks);
    return transactPromotion(
      ctl,
      transaction,
      promotion.candidate,
      promotion.proposedGeneration,
      retained,
    );
  }
  async function retired(identity, acknowledgment) {
    const row = await read(identity);
    // A legacy source releases protection before it acknowledges and cannot verify.
    if (row.attestation && row.state === "consumed") return;
    const verified = row.retirementVerification;
    if (
      !verified ||
      !isDeepStrictEqual(verified.request, acknowledgment.request) ||
      verified.proof.provenAt > acknowledgment.retiredAt ||
      verified.proof.expiresAt <= acknowledgment.retiredAt
    )
      refuse("Retirement filesystem verification is unconfirmed");
    if (
      row.state === "consumed" &&
      !isDeepStrictEqual(verified.proof.snapshot, row.proof.snapshot)
    )
      refuse("Retirement inventory changed");
  }
  return {
    prepare,
    committed,
    candidate,
    promotionChecks,
    promote,
    cancel,
    cancelPreparation,
    retired,
    sourceEvidence,
    attestPreservation: attested.attest,
  };
}
module.exports = { createArtifactHandoff };
