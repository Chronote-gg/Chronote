"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { bindingHash, continuationBinding } = require("./continue-sandbox.cjs");
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
const eventEvidenceSchema = z
  .object({
    kind: z.literal("ecs_service_stop_event"),
    eventId: z.string().min(1),
    eventBodySha256: sha,
    eventCaptureSha256: sha,
    inspectionReceiptSha256: sha,
    historicalPacketCanonicalHash: sha,
    historicalInspectionBindingSha256: sha,
    historicalExecutorCommit: z.literal(
      "d19b4fe09885f1f3c65816f89454d2c9e49ed0ff",
    ),
    inspectionWindowStart: date,
    inspectionWindowEnd: date,
  })
  .strict();
const eventReceiptProofSchema = eventEvidenceSchema
  .extend({
    eventCreatedAt: date,
    nativeObservation: z.literal("MISSING"),
  })
  .strict();
function eventProjection(service, event) {
  assert(Number.isFinite(Date.parse(event.createdAt)));
  return {
    serviceArn: service.serviceArn,
    clusterArn: service.clusterArn,
    id: event.id,
    createdAt: new Date(event.createdAt).toISOString(),
    message: event.message,
  };
}
function createServiceEventProof({ packet, now }) {
  const evidence = eventEvidenceSchema.parse(packet.eventEvidence);
  const operation = packet.operation,
    d = operation.deployment;
  const ecs = `arn:aws:ecs:${packet.region}:${packet.accountId}:`;
  const taskId = d.outgoing.taskArn.split("/").at(-1);
  assert(d.outgoing.taskArn.startsWith(ecs + "task/" + d.cluster + "/"));
  const start = Date.parse(evidence.inspectionWindowStart),
    end = Date.parse(evidence.inspectionWindowEnd);
  assert(start <= end && end <= now() * 1000);
  let verified;
  function validateService(service) {
    assert.equal(service.clusterArn, ecs + "cluster/" + d.cluster);
    assert.equal(
      service.serviceArn,
      ecs + "service/" + d.cluster + "/" + d.service,
    );
    const events = (service.events ?? []).filter(
      (e) => e.id === evidence.eventId,
    );
    assert.equal(events.length, 1);
    const projection = eventProjection(service, events[0]);
    assert.equal(
      projection.message,
      `(service ${d.service}) has stopped 1 running tasks: (task ${taskId}).`,
    );
    assert.equal(bindingHash(projection), evidence.eventBodySha256);
    assert(Date.parse(projection.createdAt) <= start);
    verified = projection;
  }
  function assertOriginal(ctl, candidate) {
    assert.deepEqual(continuationBinding(ctl, candidate), operation);
  }
  function readSource(result, ctl, candidate) {
    assert(verified, "Fresh service event validation required");
    assert.equal(ctl.coordinatorToken, operation.coordinatorToken);
    assert.equal(ctl.coordinatorEpoch, operation.coordinatorEpoch);
    assert.deepEqual(ctl.deployment.outgoing, d.outgoing);
    assert.deepEqual(candidate, operation.candidateIdentity);
    assert.equal(result.failures?.length, 1);
    const failure = result.failures[0];
    assert.equal(failure.arn, d.outgoing.taskArn);
    assert.equal(failure.reason, "MISSING");
    assert(!failure.detail);
    assert.equal(result.tasks?.length, 1);
    assert.equal(result.tasks[0].taskArn, candidate.taskArn);
    return {
      terminalProof: {
        ...evidence,
        eventCreatedAt: verified.createdAt,
        nativeObservation: "MISSING",
      },
    };
  }
  return { assertOriginal, readSource, validateService };
}
module.exports = {
  eventEvidenceSchema,
  eventReceiptProofSchema,
  eventProjection,
  createServiceEventProof,
};
