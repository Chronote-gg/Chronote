"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const { bindingHash, continuationBinding } = require("./continue-sandbox.cjs");
const { assertStoppedSource } = require("./source-task-proof.cjs");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime({ offset: true });
const packetSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("operator_retained_ecs_stop"),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    capturedAt: date,
    originalSnapshotSha256: sha256,
    provenance: z.literal("operator_captured_provider_response"),
    operationBinding: z.record(z.string(), z.unknown()),
    sourceTask: z
      .object({
        taskArn: z.string().min(1),
        clusterArn: z.string().min(1),
        taskDefinitionArn: z.string().min(1),
        group: z.string().min(1),
        lastStatus: z.literal("STOPPED"),
        desiredStatus: z.literal("STOPPED"),
        stoppedAt: date,
        version: z.number().int().positive(),
        containers: z
          .array(
            z
              .object({
                name: z.string().min(1),
                imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
                lastStatus: z.literal("STOPPED"),
                exitCode: z.number().int(),
              })
              .strict(),
          )
          .length(1),
      })
      .strict(),
  })
  .strict();
function createRetainedStopProof({ json, expectedSha256, env, now }) {
  sha256.parse(expectedSha256);
  const packet = packetSchema.parse(JSON.parse(json));
  const hash = bindingHash(packet);
  assert.equal(hash, expectedSha256);
  assert.equal(packet.accountId, env.EXPECTED_ACCOUNT_ID);
  assert.equal(packet.region, env.AWS_REGION);
  assert.ok(
    Date.parse(packet.sourceTask.stoppedAt) <= Date.parse(packet.capturedAt),
  );
  function chronology() {
    assert.ok(Date.parse(packet.capturedAt) <= now() * 1000);
  }
  chronology();
  function assertOriginal(ctl, candidate) {
    assert.equal(
      bindingHash(packet.operationBinding),
      bindingHash(continuationBinding(ctl, candidate)),
    );
  }
  function sourceContext(ctl, candidate, config) {
    chronology();
    const d = ctl.deployment;
    const b = packet.operationBinding;
    assert.equal(ctl.coordinatorToken, b.coordinatorToken);
    assert.equal(ctl.coordinatorEpoch, b.coordinatorEpoch);
    assert.deepEqual(candidate, b.candidateIdentity);
    for (const field of [
      "runToken",
      "cluster",
      "service",
      "family",
      "tablePrefix",
      "candidateId",
      "image",
      "runtimeMode",
      "originalGeneration",
      "originalMembers",
      "outgoing",
      "previousTaskDefinition",
      "taskDefinition",
    ])
      assert.deepEqual(d[field], b.deployment[field]);
    for (const field of [
      "listenerArn",
      "sourceGroup",
      "candidateGroup",
      "containerName",
      "containerPort",
      "sourceRevision",
    ])
      assert.deepEqual(d.routing[field], b.deployment.routing[field]);
    const ecs = `arn:aws:ecs:${packet.region}:${packet.accountId}:`;
    assert.equal(
      packet.sourceTask.clusterArn,
      ecs + "cluster/" + config.cluster,
    );
    assert.ok(
      packet.sourceTask.taskArn.startsWith(
        ecs + "task/" + config.cluster + "/",
      ),
    );
    assertStoppedSource(packet.sourceTask, d, config, now);
    assert.equal(packet.sourceTask.containers[0].name, d.routing.containerName);
  }
  function readSource(result, ctl, candidate, config) {
    sourceContext(ctl, candidate, config);
    const failures = result.failures ?? [];
    let observation;
    if (failures.length) {
      assert.equal(failures.length, 1);
      assert.equal(failures[0].arn, ctl.deployment.outgoing.taskArn);
      assert.equal(failures[0].reason, "MISSING");
      assert.ok(!failures[0].detail);
      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks[0].taskArn, candidate.taskArn);
      observation = "MISSING";
    } else {
      assert.equal(result.tasks.length, 2);
      const source = result.tasks.find(
        (task) => task.taskArn === ctl.deployment.outgoing.taskArn,
      );
      assertStoppedSource(source, ctl.deployment, config, now);
      assert.equal(source.clusterArn, packet.sourceTask.clusterArn);
      assert.equal(
        Date.parse(source.stoppedAt),
        Date.parse(packet.sourceTask.stoppedAt),
      );
      assert.ok(source.version >= packet.sourceTask.version);
      const container = source.containers.find(
        (c) => c.name === ctl.deployment.routing.containerName,
      );
      assert.equal(container.lastStatus, "STOPPED");
      assert.equal(
        container.exitCode,
        packet.sourceTask.containers[0].exitCode,
      );
      observation = "STOPPED";
    }
    return {
      stoppedAt: packet.sourceTask.stoppedAt,
      terminalProof: {
        kind: packet.kind,
        packetSha256: hash,
        originalSnapshotSha256: packet.originalSnapshotSha256,
        capturedAt: packet.capturedAt,
        provenance: packet.provenance,
        nativeObservation: observation,
      },
    };
  }
  return { assertOriginal, readSource };
}
module.exports = {
  packetSchema,
  createRetainedStopProof,
  terminalPacketSha256: bindingHash,
};
