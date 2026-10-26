import { supplementIdentity } from "./productionAcceptance.js";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { sample } from "./productionFixtureAcceptance";
import { completeManifest } from "./productionCompleteManifest.js";
import { bound } from "./productionManifest.js";
import { fixtureFolder } from "../../scripts/deployment/production-content-policy.cjs";
import { frozenFixtureDefinitions } from "../../scripts/deployment/production-fixture-definitions.cjs";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function shiftDates(value, milliseconds) {
  if (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return new Date(Date.parse(value) + milliseconds).toISOString();
  if (Array.isArray(value))
    return value.map((entry) => shiftDates(entry, milliseconds));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        shiftDates(entry, milliseconds),
      ]),
    );
  return value;
}
export function contentFixture({
  secondOffsetSeconds = 0,
  firstOffsetSeconds = 0,
  binding: providedBinding,
  ownerIds,
} = {}) {
  const binding = providedBinding ?? bound(completeManifest()),
    m = binding.manifest;
  const objects = new Map();
  const fixtures = m.handoff.grants.map((expected, index) => {
    const { grant, history } = sample();
    const offset = index === 0 ? firstOffsetSeconds : secondOffsetSeconds;
    if (offset) Object.assign(history, shiftDates(history, offset * 1000));
    Object.assign(grant, expected, { pk: `FIXTURE#${expected.grantId}` });
    const owner =
      ownerIds?.[index] ??
      `11111111-2222-4333-8444-${String(index + 1).padStart(12, "0")}`;
    Object.assign(grant.ownership, {
      meetingId: expected.meetingId,
      ownerInstanceId: owner,
    });
    grant.historyKey.channelId_timestamp += index;
    Object.assign(history, grant.historyKey, {
      meetingId: expected.meetingId,
      ownerInstanceId: owner,
    });
    Object.assign(history.fixtureInput, {
      reference: {
        holdId: grant.holdId,
        introductionId: grant.introductionId,
        revision: 1,
        grantId: grant.grantId,
      },
      commandId: grant.commandId,
      scriptSha256: grant.scriptSha256,
      checklistSha256: grant.checklistSha256,
      ownership: grant.ownership,
      historyKey: grant.historyKey,
    });
    Object.assign(history.checkpoint.capture, grant.historyKey, {
      meetingId: grant.meetingId,
      ownerInstanceId: owner,
    });
    const folder = fixtureFolder(
      m,
      index,
      history.checkpoint.capture.reservedAt,
    );
    const prefix = `${folder}checkpoints/v1/1-${owner}/`;
    const add = (key, bytes) => {
      const reference = {
        key,
        checksumSha256: hash(bytes),
        byteLength: bytes.length,
      };
      objects.set(key, {
        bytes,
        reference,
        versionId: `version-${objects.size}`,
      });
      return reference;
    };
    const pcm = Buffer.alloc(400000, 1);
    const artifact = {
      kind: "audio",
      sourceId: "user:actor",
      sequence: 1,
      contentType: "application/octet-stream",
      format: { encoding: "pcm_s16le", sampleRate: 1000, channels: 1 },
      timing: {
        basis: "sample_cursor_with_observed_gaps",
        observedFirstOffsetMs: 0,
        observedLastOffsetMs: 200000,
        maxCursorAdjustmentMs: 0,
      },
      coverage: {
        kind: "known",
        intervals: [
          { sourceId: "user:actor", startOffsetMs: 0, durationMs: 200000 },
        ],
      },
      object: add(`${prefix}audio/user%3Aactor/1-${hash(pcm)}`, pcm),
    };
    const transcription = {
      kind: "transcription",
      sourceId: "user:actor",
      sequence: 1,
      contentType: "application/json",
      coverage: { kind: "unknown" },
      object: {
        key: `${prefix}transcription/user%3Aactor/1-${"a".repeat(64)}`,
        checksumSha256: "a".repeat(64),
        byteLength: 8,
      },
    };
    const manifest = {
      schemaVersion: 1,
      artifactFolder: folder,
      revision: 4,
      capture: history.checkpoint.capture,
      fixtureInput: history.fixtureInput,
      captureState: history.capture,
      coverage: {
        kind: "verified",
        intervals: artifact.coverage.intervals,
        savedDurationMs: 200000,
        lastConfirmedCaptureAt: history.capture.endedAt,
      },
      artifacts: [artifact, transcription],
    };
    const bytes = Buffer.from(JSON.stringify(manifest));
    history.checkpoint.artifactFolder = folder;
    history.checkpoint.manifest = add(
      `${prefix}manifests/4-${hash(bytes)}.json`,
      bytes,
    );
    const transcript = add(
      `${folder}transcript.json`,
      Buffer.from('{"text":"generated synthetic transcript"}'),
    );
    const versionId = objects.get(transcript.key).versionId;
    history.fixtureTranscript = {
      ...transcript,
      acknowledgment: { state: "acknowledged", versionId },
    };
    history.transcriptS3Key = transcript.key;
    const notes = "Generated synthetic notes";
    const review = {
      grantId: grant.grantId,
      commandId: grant.commandId,
      meetingId: grant.meetingId,
      ownerInstanceId: owner,
      executionVersion: 1,
      voiceOperationAttemptId: grant.ownership.voiceOperationAttemptId,
      historyKey: grant.historyKey,
      transcript: { ...transcript, versionId },
      manifest: {
        ...history.checkpoint.manifest,
        versionId: objects.get(history.checkpoint.manifest.key).versionId,
      },
      notes: {
        version: 1,
        checksumSha256: hash(Buffer.from(notes)),
        byteLength: Buffer.byteLength(notes),
        channelId: history.notesChannelId,
        messageIds: history.notesMessageIds,
      },
      scriptSha256: grant.scriptSha256,
      checklistSha256: grant.checklistSha256,
      scriptFidelity: "pass",
      ambientInputAbsent: "pass",
      items: frozenFixtureDefinitions().fixtures[index].checklist.map(
        (_, n) => ({ index: n, transcript: "pass", notes: "pass" }),
      ),
    };
    const identity = {
      kind: "ecs",
      protocolVersion: 1,
      instanceId: owner,
      taskArn: `${m.runtime.clusterArn.replace(":cluster/", ":task/")}/task-${index}`,
      candidateId: index ? m.handoff.candidateId : m.runtime.candidateId,
      imageDigest: index
        ? m.runtime.continuationDigest
        : m.runtime.candidateDigest,
    };
    const runtime = {
      pk: "ENV",
      sk: `RUNTIME#${owner}`,
      recordType: "runtime",
      identity,
      role: index ? "serving" : "retired",
      authorizedGeneration: index + 1,
      heartbeatAt: 320,
      readiness: {
        identity,
        runtimeMode: "all",
        observedEpoch: 2,
        observedGeneration: index + 1,
        gatewayReady: true,
        cacheReady: true,
        dependenciesReady: true,
        provenAt: 320,
        expiresAt: 400,
      },
      protection: { identity, provenAt: 320, expiresAt: 400 },
    };
    return { grant, history, notes, review, runtime };
  });
  const control = {
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "ecs",
    protocolVersion: 1,
    coordinatorToken: m.handoff.runToken,
    coordinatorEpoch: 2,
    coordinatorExpiresAt: 400,
    servingGeneration: 2,
    servingMembers: {
      [fixtures[1].runtime.identity.instanceId]: fixtures[1].runtime.identity,
    },
    maintenance: {
      holdId: m.holdId,
      introductionId: m.introductionId,
      revision: 1,
    },
    deployment: {
      runToken: m.handoff.runToken,
      cluster: m.runtime.clusterArn,
      service: m.runtime.serviceArn,
      family: m.runtime.family,
      tablePrefix: "test-",
      candidateId: m.handoff.candidateId,
      image: `app@${m.runtime.continuationDigest}`,
      runtimeMode: "all",
      phase: "complete",
      originalGeneration: 1,
      originalMembers: [fixtures[0].runtime.identity],
      outgoing: fixtures[0].runtime.identity,
      previousTaskDefinition: m.runtime.candidateDefinition,
      updatedAt: 310,
    },
  };
  const hold = {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    ...control.maintenance,
    manifestHash: binding.manifestHash,
    admission: { state: "held" },
    deployment: { state: "held" },
  };
  const authority = {
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: "FIXTURE_COORDINATOR",
    recordType: "fixture_coordinator_authority",
    ...control.maintenance,
    manifestHash: binding.manifestHash,
    runToken: m.handoff.runToken,
    priorRunToken: m.handoff.priorRunToken,
    priorEpoch: 1,
    priorGeneration: 1,
    priorMember: fixtures[0].runtime.identity,
    candidateId: m.handoff.candidateId,
    taskDefinition: m.runtime.continuationDefinition,
    imageDigest: m.runtime.continuationDigest,
  };
  const supplement = {
    ...supplementIdentity(binding, 319000),
    fixtures: fixtures.map((f) => f.review),
  };
  return { binding, fixtures, objects, control, hold, authority, supplement };
}
