"use strict";
const assert = require("node:assert/strict");
const { controlAuthority } = require("./carryforward-state.cjs");
const { createRuntimeProof } = require("./runtime-proof.cjs");
const { createRouting, action } = require("./routing.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
function createCarryforwardAuthority({
  aws,
  inspector,
  config,
  env,
  types,
  now,
  runToken,
  claim,
  recovery,
  fixedTaskDefinition,
}) {
  const proof = createRuntimeProof({ aws, config, types, now, diagnostic: {} });
  const routing = createRouting({
    aws,
    config,
    env,
    failure: (category, message) => new CoordinatorFailure(category, message),
  });
  function own(current) {
    assert.equal(current.coordinatorToken, runToken);
    assert.equal(current.coordinatorEpoch, claim.next.coordinatorEpoch);
    const d = current.deployment;
    if (fixedTaskDefinition)
      assert.equal(d.taskDefinition, fixedTaskDefinition);
    for (const key of [
      "runToken",
      "cluster",
      "service",
      "family",
      "tablePrefix",
      "candidateId",
      "image",
      "outgoing",
      "originalMembers",
      "originalGeneration",
      "previousTaskDefinition",
      "runtimeMode",
    ])
      assert.deepEqual(d[key], claim.next.deployment[key]);
    const members = Object.values(current.servingMembers);
    assert.equal(members.length, 1);
    const sourceSelected = types.sameRuntimeIdentity(
      members[0],
      claim.archive.source,
    );
    assert.ok(
      sourceSelected || types.sameRuntimeIdentity(members[0], d.candidate),
    );
    return [
      ...new Map(
        [...members, ...(d.candidate ? [d.candidate] : [])].map((identity) => [
          identity.instanceId,
          identity,
        ]),
      ).values(),
    ];
  }
  async function runtime(identity) {
    return types.runtimeRecordSchema.parse(
      await inspector.read("ENV", "RUNTIME#" + identity.instanceId),
    );
  }
  function sourceRetired(row, ctl) {
    const d = ctl.deployment;
    assert.ok(types.sameRuntimeIdentity(row.identity, claim.archive.source));
    assert.equal(row.authorizedGeneration, d.originalGeneration);
    assert.equal(row.expiresAt, undefined);
    const request = {
      identity: d.outgoing,
      authorizedGeneration: d.originalGeneration,
      coordinatorToken: runToken,
      coordinatorEpoch: ctl.coordinatorEpoch,
    };
    if (row.retirementRequest) assert.deepEqual(row.retirementRequest, request);
    if (row.role === "retired") {
      assert.deepEqual(row.retirementRequest, request);
      assert.deepEqual(row.retirementAcknowledgment?.request, request);
      assert.ok(
        row.retirementAcknowledgment.retiredAt >= claim.archive.archivedAt &&
          row.retirementAcknowledgment.retiredAt <= now(),
      );
      assert.ok(
        row.workCounts &&
          Object.values(row.workCounts).every((count) => count === 0),
      );
      return true;
    }
    assert.ok(["serving", "draining", "releasing"].includes(row.role));
    assert.equal(row.retirementAcknowledgment, undefined);
    if (row.role !== "serving")
      assert.deepEqual(row.retirementRequest, request);
    return false;
  }
  async function sourceProtection(outgoing, ctl) {
    if (!outgoing || sourceRetired(await runtime(outgoing), ctl)) return {};
    try {
      return {
        expiry:
          Date.parse((await proof.protectedTask(outgoing)).expirationDate) /
          1000,
      };
    } catch (error) {
      // Retirement releases protection before publishing its acknowledgment.
      return { error };
    }
  }
  async function assertBeforeWrite(operation, input) {
    assert.deepEqual(
      await inspector.read(inspector.archiveKey, "ARCHIVE"),
      claim.archive,
    );
    assert.deepEqual(await inspector.read(recovery.pk, "RECOVERY"), recovery);
    const current = await inspector.control();
    const identities = own(current);
    const expirations = await Promise.all(
      identities.map(
        async (identity) =>
          Date.parse((await proof.protectedTask(identity)).expirationDate) /
          1000,
      ),
    );
    const outgoing = current.servingMembers[claim.archive.source.instanceId]
      ? undefined
      : claim.archive.source;
    const source = await sourceProtection(outgoing, current);
    if (operation === "modify-listener") {
      const r = current.deployment.routing;
      assert.equal(r.state, "forward_submitted");
      assert.equal(input.ListenerArn, r.listenerArn);
      assert.deepEqual(input.DefaultActions, action(r, true));
      const response = await aws("ecs", "describe-services", {
        cluster: config.cluster,
        services: [config.service],
      });
      assert.ok(!response.failures?.length && response.services?.length === 1);
      await routing.validate(
        current,
        response.services[0],
        current.deployment.candidate,
      );
      await routing.assertAction(r, false);
    }
    const late = await inspector.control();
    assert.deepEqual(controlAuthority(late), controlAuthority(current));
    const rows = await Promise.all(
      [...identities, ...(outgoing ? [outgoing] : [])].map(runtime),
    );
    for (const [index, row] of rows.slice(0, identities.length).entries()) {
      assert.ok(
        proof.ready(row, late, identities[index], late.deployment.runtimeMode),
      );
      assert.equal(row.authorizedGeneration, late.servingGeneration);
      assert.equal(
        row.role,
        late.servingMembers[identities[index].instanceId]
          ? "serving"
          : "candidate",
      );
      assert.ok(!row.retirementRequest && !row.retirementAcknowledgment);
    }
    if (outgoing && !sourceRetired(rows[identities.length], late)) {
      if (source.error) throw source.error;
      assert.ok(
        source.expiry > now() + 120,
        "Outgoing source protection expired before provider mutation",
      );
    }
    assert.ok(
      late.coordinatorExpiresAt > now(),
      "Coordinator authority expired before provider mutation",
    );
    assert.ok(expirations.every((expiry) => expiry > now() + 120));
  }
  return { assertBeforeWrite };
}
module.exports = { createCarryforwardAuthority };
