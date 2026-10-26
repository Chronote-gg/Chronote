import {
  generatedRuntimeProtection,
  completeGeneratedHistory,
} from "./fixtures/runtimeFixtureHelpers";
jest.mock("../../src/services/meetingControlBotService", () => ({
  executeMeetingControlCommand: jest.fn(),
}));
// The only SDK substitution binds every real command to the explicit local fixture.
jest.mock("@aws-sdk/client-dynamodb", () =>
  jest
    .requireActual("./fixtures/loopbackDynamoMock")
    .createLoopbackDynamoMock(),
);
jest.mock("../../src/services/configService", () => {
  process.env.DDB_TABLE_PREFIX = `warm-handoff-${jest.requireActual("node:crypto").randomUUID()}-`;
  return jest.requireActual("../../src/services/configService");
});
jest.mock("../../src/services/runtimeLifecycleService", () =>
  jest.requireActual("./fixtures/runtimeModuleMock").createRuntimeModuleMock(),
);
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: jest.fn(() => "old"),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  ...jest.requireActual("../../src/services/unifiedConfigService"),
  resolveConfigSnapshot: async () => ({ values: {} }),
}));
jest.mock("../../src/services/personalMediaUploadProcessingService", () => ({
  createPersonalMediaProcessingMeeting: jest.fn(async (job) => job),
  processPersonalMediaUpload: jest.fn(),
}));
import {
  DeleteTableCommand,
  DeleteItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "node:crypto";
import { planGeneratedDescendantRemoval } from "../../scripts/deployment/verify-sandbox-handoff.cjs";
import type { Client } from "discord.js";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import { getMeetingControlCommandRepository } from "../../src/repositories/meetingControlCommandRepository";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import { executeMeetingControlCommand } from "../../src/services/meetingControlBotService";
import { config } from "../../src/services/configService";
import * as database from "../../src/db";
import { getActiveMeetingLease, personalMediaClaimForJob } from "../../src/db";
import {
  tryAcquireMeetingLease,
  attachMeetingReservation,
  releaseSessionReservation,
} from "../../src/services/activeMeetingLeaseService";
import { runOwnedMeetingFinalization } from "../../src/services/meetingFinalizationService";
import {
  createRuntimeLifecycle,
  beginRuntimeWork,
  getRuntimeAdmissionContext,
} from "../../src/services/runtimeLifecycleService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import { beginRuntimeWorkClaim } from "../../src/services/runtimeWorkAdmissionService";
import { createMeetingRecoveryWorker } from "../../src/services/meetingRecoveryWorkerService";
import { recoverMeeting } from "../../src/services/meetingRecoveryService";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { processPersonalMediaUploadJob } from "../../src/services/personalMediaUploadWorkerService";
import { processPersonalMediaUpload } from "../../src/services/personalMediaUploadProcessingService";
import { buildRollbackPromotionTransaction } from "../../src/services/deploymentControlTransactions";
import {
  createRecoveryFaultDatabase,
  recoveryFaultFixture,
  generatedAudio,
  barrier,
} from "./fixtures/recordingRecoveryFaultFixture";
import { control, runtime, history } from "./controlFixtures";
import type { MeetingData } from "../../src/types/meeting-data";
import type {
  ControlRecord,
  SessionReservation,
} from "../../src/types/deploymentControl";

const prefix = config.database.tablePrefix;
const db = createRecoveryFaultDatabase({
  deploymentControl: `${prefix}DeploymentControlTable`,
  meetingHistory: `${prefix}MeetingHistoryTable`,
  activeMeeting: `${prefix}ActiveMeetingTable`,
});
const uploadTable = `${prefix}PersonalMediaUploadJobTable`;
const commandTable = `${prefix}MeetingControlCommandTable`;
const lifecycles: ReturnType<typeof createRuntimeLifecycle>[] = [];
const now = () => Math.floor(Date.now() / 1000);
beforeAll(async () => {
  await db.start();
  await db.createTable(commandTable, ["requestId"]);
  jest
    .spyOn(database, "getDeploymentControlRepository")
    .mockReturnValue(db.repository);
  await db.createTable(uploadTable, ["uploadId"]);
});
afterAll(async () => {
  for (const lifecycle of lifecycles) lifecycle.stop();
  await db.client.send(new DeleteTableCommand({ TableName: uploadTable }));
  await db.client.send(new DeleteTableCommand({ TableName: commandTable }));
  await db.close();
});
async function startRuntime(id: string, ready = true) {
  const identity = runtime(id).identity;
  if (identity.kind !== "ecs")
    throw new Error("Generated ECS identity required");
  const protection = generatedRuntimeProtection(identity, now);
  const lifecycle = createRuntimeLifecycle({
    identity,
    repository: db.repository,
    protection,
    now,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: ready,
      cacheReady: ready,
      dependenciesReady: ready,
    }),
  });
  lifecycles.push(lifecycle);
  await lifecycle.start();
  return { lifecycle, identity, protection };
}
async function select(owner: Awaited<ReturnType<typeof startRuntime>>) {
  jest
    .mocked(beginRuntimeWork)
    .mockImplementation(owner.lifecycle.beginRuntimeWork);
  jest
    .mocked(getRuntimeAdmissionContext)
    .mockImplementation(owner.lifecycle.getRuntimeAdmissionContext);
  jest.mocked(getRuntimeInstanceId).mockReturnValue(owner.identity.instanceId);
  return owner.lifecycle.getRuntimeAdmissionContext();
}
async function promote(candidate: Awaited<ReturnType<typeof startRuntime>>) {
  const current = (await db.repository.getRecord(
    "ENV",
    "CONTROL",
  )) as ControlRecord;
  return db.repository.promote({
    candidateRuntimeMode: "all",
    coordinatorToken: current.coordinatorToken,
    coordinatorEpoch: current.coordinatorEpoch,
    expectedServingGeneration: current.servingGeneration,
    expectedServingMembers: Object.values(current.servingMembers),
    candidate: candidate.identity,
    proposedGeneration: current.servingGeneration + 1,
    now: now(),
  });
}
async function reserve(
  owner: Awaited<ReturnType<typeof startRuntime>>,
  mode: "meeting" | "tts_only" = "meeting",
  held?: ReturnType<typeof barrier>,
) {
  const admissionContext = await select(owner);
  const guildId = randomUUID(),
    meetingId = randomUUID();
  const common = {
    guildId,
    meetingId,
    voiceChannelId: "voice",
    textChannelId: "text",
    isAutoRecording: false,
    reservedAt: Date.now(),
    admissionContext,
    assertStartAllowed: held ? () => held.promise : undefined,
  };
  const request =
    mode === "meeting"
      ? {
          ...common,
          sessionMode: "meeting" as const,
          history: { ...history, guildId, meetingId },
        }
      : { ...common, sessionMode: "tts_only" as const };
  return { pending: tryAcquireMeetingLease(request), guildId, meetingId };
}
async function attach(
  pending: Promise<Awaited<ReturnType<typeof tryAcquireMeetingLease>>>,
) {
  const result = await pending;
  if (result.kind !== "admitted")
    throw new Error(`Generated start refused: ${result.reason}`);
  const meeting = {
    reservation: result.reservation,
    guildId: result.reservation.guildId,
  } as MeetingData;
  attachMeetingReservation(meeting, result.reservation);
  return meeting;
}
async function finalizeHistory(reservation: SessionReservation) {
  if (reservation.sessionMode !== "meeting") return;
  const proof = {
    key: reservation.historyKey,
    expectedMeetingId: reservation.meetingId,
    expectedOwnerInstanceId: reservation.ownerInstanceId,
    expectedExecutionVersion: reservation.executionVersion,
  };
  await completeGeneratedHistory(db.repository, proof, {
    status: "complete",
    notes: "Generated fixture outcome",
    processing: { notes: "generated" },
  });
}
async function finish(meeting: MeetingData) {
  const reservation = meeting.reservation!;
  await runOwnedMeetingFinalization(meeting, () =>
    finalizeHistory(reservation),
  );
  meeting.finalization!.disposition = "durable";
  expect(await releaseSessionReservation(reservation)).toBe(true);
  expect(await getActiveMeetingLease(reservation.guildId)).toBeUndefined();
  expect(
    await db.repository.getRecord(`VOICE#${reservation.guildId}`, "STATE"),
  ).toMatchObject({
    state: "settled",
    ownerInstanceId: reservation.ownerInstanceId,
  });
}
async function seedControl() {
  await db.put(db.tables.deploymentControl, {
    ...control,
    coordinatorExpiresAt: now() + 600,
    servingGeneration: 0,
    servingMembers: {},
  });
}
async function assertHistory(reservation: SessionReservation, status: string) {
  if (reservation.sessionMode !== "meeting")
    throw new Error("Recording required");
  expect(
    await db.repository.getMeetingHistory(reservation.historyKey),
  ).toMatchObject({
    status,
    ownerInstanceId: reservation.ownerInstanceId,
    executionVersion: 1,
  });
}

test("real producers preserve old ownership through warmup, failed candidate, promotion, control, finalization and retirement", async () => {
  const recovery = await recoveryFaultFixture(db);
  expect(
    (
      await recovery.reader.flush({
        ...recovery.input,
        captureState: {
          kind: "interrupted",
          startedAt: recovery.row.timestamp,
          endedAt: null,
          detectedAt: new Date().toISOString(),
        },
      })
    ).kind,
  ).toBe("committed");
  await db.put(db.tables.activeMeeting, {
    ...recovery.lease,
    leaseExpiresAt: now() - 1,
  });
  await db.client.send(
    new DeleteItemCommand({
      TableName: db.tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: "RUNTIME#old" }),
    }),
  );
  await seedControl();
  const old = await startRuntime("old");
  expect(await promote(old)).toBe("applied");
  const original = await attach((await reserve(old)).pending);
  const pendingGate = barrier();
  const reserveReal = db.repository.reserveSession.bind(db.repository);
  const committed = barrier();
  const reserveSpy = jest
    .spyOn(db.repository, "reserveSession")
    .mockImplementationOnce(async (request) => {
      const result = await reserveReal(request);
      committed.release();
      await pendingGate.promise;
      return result;
    });
  const pending = await reserve(old);
  await committed.promise;
  expect(old.lifecycle.getWorkCounts()).toMatchObject({
    recording: 1,
    pending_admission: 1,
  });
  const failed = await startRuntime("failed", false);
  expect(await promote(failed)).toBe("stale");

  const tts = await attach((await reserve(old, "tts_only")).pending);
  expect(old.lifecycle.getWorkCounts()).toMatchObject({
    recording: 1,
    voice_operation: 1,
  });
  await assertHistory(original.reservation!, "starting");
  const finishWorkers = await startWorkers(old, recovery);
  const good = await startRuntime("good");
  expect(
    Object.values(good.lifecycle.getWorkCounts()).every((value) => value === 0),
  ).toBe(true);
  expect(await promote(good)).toBe("applied");
  expect(
    (await old.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 })).kind,
  ).toBe("busy");
  expect(old.lifecycle.getWorkCounts().pending_admission).toBe(1);
  pendingGate.release();
  const duringWarmup = await attach(pending.pending);
  reserveSpy.mockRestore();
  const newGuild = await attach((await reserve(good)).pending);
  await assertHistory(newGuild.reservation!, "starting");
  await expect(old.lifecycle.getRuntimeAdmissionContext()).rejects.toThrow();
  jest
    .mocked(beginRuntimeWork)
    .mockImplementation(old.lifecycle.beginRuntimeWork);
  jest
    .mocked(getRuntimeAdmissionContext)
    .mockImplementation(old.lifecycle.getRuntimeAdmissionContext);
  jest.mocked(getRuntimeInstanceId).mockReturnValue("old");
  const finalizerGate = barrier(),
    finalizerEntered = barrier();
  const commands = getMeetingControlCommandRepository();
  const command: MeetingControlCommand = {
    requestId: randomUUID(),
    queueStatus: "pending",
    commandType: "stop_meeting",
    userId: "generated-user",
    input: {
      serverId: original.reservation!.guildId,
      meetingId: original.reservation!.meetingId,
    },
    targetOwnerInstanceId: "old",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: now() + 60,
  };
  await commands.writeCommand(command);
  jest
    .mocked(executeMeetingControlCommand)
    .mockImplementationOnce(async (_client, claimed, assertOwned, signal) => {
      await assertOwned?.();
      signal?.throwIfAborted();
      await runOwnedMeetingFinalization(original, async () => {
        finalizerEntered.release();
        await finalizerGate.promise;
        await finalizeHistory(original.reservation!);
      });
      return {
        status: "ended",
        serverId: claimed.input.serverId!,
        meetingId: original.reservation!.meetingId,
      };
    });
  const controlled = processMeetingControlCommand({} as Client, command);
  await finalizerEntered.promise;
  expect(old.lifecycle.getWorkCounts()).toMatchObject({
    finalization: 1,
    ancillary_delivery: 2,
  });
  expect(await commands.getCommand(command.requestId)).toMatchObject({
    claimedByInstanceId: "old",
    queueStatus: "pending",
  });
  expect(
    (await old.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 })).kind,
  ).toBe("busy");
  finalizerGate.release();
  await controlled;
  expect(await commands.getCommand(command.requestId)).toMatchObject({
    claimedByInstanceId: "old",
    queueStatus: "completed",
    result: { status: "ended" },
  });
  const originalReservation = original.reservation!;
  original.finalization!.disposition = "durable";
  expect(await releaseSessionReservation(originalReservation)).toBe(true);
  await finish(duringWarmup);
  await finish(tts);
  await assertHistory(originalReservation, "complete");
  expect(
    (await old.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 })).kind,
  ).toBe("busy");
  await finishWorkers();
  expect(
    (await old.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 })).kind,
  ).toBe("retired");
  expect(old.protection.isSafe()).toBe(false);
  expect(await db.repository.getRecord("ENV", "RUNTIME#old")).toMatchObject({
    role: "retired",
  });
  await select(good);

  await finish(newGuild);
});

async function startWorkers(
  good: Awaited<ReturnType<typeof startRuntime>>,
  recovery: Awaited<ReturnType<typeof recoveryFaultFixture>>,
) {
  const recoveryGate = barrier(),
    entered = barrier();
  const worker = createMeetingRecoveryWorker({
    repository: db.repository,
    begin: beginRuntimeWorkClaim,
    recover: recoverMeeting,
    now,
    content: {
      ...recovery.deps,
      notes: async (input) => {
        entered.release();
        await recoveryGate.promise;
        return recovery.deps.notes(input);
      },
    },
  });
  const recovering = worker.process(recovery.row);
  await Promise.race([
    entered.promise,
    recovering.then(async () => {
      throw new Error("Recovery ended before the generated notes barrier");
    }),
  ]);
  expect(good.lifecycle.getWorkCounts().recovery_processing).toBe(1);
  expect((await recovery.readHistory()).recovery?.disposition).toBe("claimed");
  const uploads = getPersonalMediaUploadRepository();
  const job = {
    uploadId: randomUUID(),
    ownerUserId: "generated-owner",
    status: "queued" as const,
    mediaKind: "audio" as const,
    sourceS3Key: "generated-source",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await uploads.write(job, await good.lifecycle.getRuntimeAdmissionContext());
  const processingGate = barrier(),
    processingEntered = barrier(),
    ancillaryGate = barrier(),
    ancillaryEntered = barrier();
  jest
    .mocked(processPersonalMediaUpload)
    .mockImplementationOnce(
      async (claimed, instanceId, signal, acknowledged) => {
        processingEntered.release();
        await processingGate.promise;
        signal?.throwIfAborted();
        const personal = {
          ...history,
          guildId: "personal:generated-owner",
          ownershipScope: "personal" as const,
          ownerUserId: job.ownerUserId,
          channelId_timestamp: `personal#${job.uploadId}`,
          meetingId: job.uploadId,
          status: "complete" as const,
          notes: "Generated personal notes",
        };
        expect(
          await uploads.writeHistory(
            personal,
            personalMediaClaimForJob(claimed, instanceId),
            { ...claimed, status: "complete" },
          ),
        ).toBe(true);
        acknowledged?.();
        ancillaryEntered.release();
        await ancillaryGate.promise;
      },
    );
  const processing = processPersonalMediaUploadJob(job);
  await Promise.race([
    processingEntered.promise,
    processing.then(async () => {
      throw new Error("Personal worker returned before processing");
    }),
  ]);
  expect(good.lifecycle.getWorkCounts().personal_processing).toBe(1);
  processingGate.release();
  await Promise.race([
    ancillaryEntered.promise,
    processing.then(async () => {
      throw new Error("Personal worker returned before ancillary");
    }),
  ]);
  expect(good.lifecycle.getWorkCounts()).toMatchObject({
    personal_processing: 0,
    ancillary_delivery: 1,
    recovery_processing: 1,
  });
  expect((await uploads.get(job.uploadId))?.status).toBe("complete");
  return async () => {
    ancillaryGate.release();
    recoveryGate.release();
    await processing;
    await recovering;
    await worker.stop();
    expect(good.lifecycle.getWorkCounts()).toMatchObject({
      personal_processing: 0,
      recovery_processing: 0,
      ancillary_delivery: 0,
    });
    expect(await recovery.readHistory()).toMatchObject({
      status: "interrupted",
      ownerInstanceId: good.identity.instanceId,
      executionVersion: 2,
      recovery: { disposition: "done" },
      notes: "Generated saved decision.",
    });
  };
}

test("exact rollback before retirement requests preserves candidate-owned recording while restoring old admission", async () => {
  await seedControl();
  const old = await startRuntime("rollback-old");
  expect(await promote(old)).toBe("applied");
  const candidate = await startRuntime("rollback-candidate");
  expect(await promote(candidate)).toBe("applied");
  const owned = await attach((await reserve(candidate)).pending);
  await old.lifecycle.refreshRuntimeReadiness();
  const current = (await db.repository.getRecord(
    "ENV",
    "CONTROL",
  )) as ControlRecord;
  const rollback: ControlRecord = {
    ...current,
    deployment: {
      runToken: "coordinator",
      cluster: "fixture",
      service: "fixture",
      family: "fixture",
      tablePrefix: prefix,
      candidateId: candidate.identity.candidateId,
      image: "fixture",
      runtimeMode: "all",
      phase: "rollback_promoting",
      originalGeneration: 1,
      originalMembers: [old.identity],
      outgoing: old.identity,
      candidate: candidate.identity,
      previousTaskDefinition: "fixture:1",
      taskDefinition: "fixture:2",
      updatedAt: now(),
    },
  };
  await db.put(db.tables.deploymentControl, rollback);
  await db.client.send(
    new TransactWriteItemsCommand(
      buildRollbackPromotionTransaction(rollback, now(), db.tables),
    ),
  );
  expect(await db.repository.getRecord("ENV", "CONTROL")).toMatchObject({
    servingGeneration: 3,
    servingMembers: { "rollback-old": old.identity },
  });
  const restored = await attach((await reserve(old)).pending);
  await assertHistory(owned.reservation!, "starting");
  expect(
    (await candidate.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 }))
      .kind,
  ).toBe("busy");
  await finish(owned);
  expect(
    (await candidate.lifecycle.prepareRuntimeRetirement({ retirementEpoch: 3 }))
      .kind,
  ).toBe("retired");
  await finish(restored);
});

test("generated checkpoint publication and orphan upload are both covered by static cleanup review, with active-owner refusal", async () => {
  const previousPrefix = config.storage.transcriptPrefix;
  const fixturePrefix = `generated/handoff/${randomUUID()}/`;
  config.storage.transcriptPrefix = fixturePrefix;
  try {
    const f = await recoveryFaultFixture(db);
    expect((await f.reader.flush(f.input)).kind).toBe("committed");
    const checkpoint = (await f.readHistory()).checkpoint!;
    const beforeUpload = new Set(f.objects.keys());
    const upload = f.upload.getMockImplementation()!;
    f.upload.mockImplementationOnce(async (...args) => {
      await upload(...args);
      throw new Error("Generated lost upload acknowledgment");
    });
    expect(
      (
        await f.reader.flush({
          ...f.input,
          previous: checkpoint,
          artifacts: [generatedAudio()],
        })
      ).kind,
    ).toBe("preservation_failed");
    expect((await f.readHistory()).checkpoint).toEqual(checkpoint);
    const orphanKeys = [...f.objects.keys()].filter(
      (key) => !beforeUpload.has(key),
    );
    expect(orphanKeys).toHaveLength(1);
    expect(
      (
        await f.reader.flush({
          ...f.input,
          previous: checkpoint,
          artifacts: [],
          captureState: {
            kind: "complete",
            startedAt: f.row.timestamp,
            endedAt: new Date(Date.parse(f.row.timestamp) + 1000).toISOString(),
          },
        })
      ).kind,
    ).toBe("committed");
    const proof = {
      key: {
        guildId: f.row.guildId,
        channelId_timestamp: f.row.channelId_timestamp,
      },
      expectedMeetingId: f.row.meetingId,
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
    };
    await completeGeneratedHistory(db.repository, proof, {
      status: "complete",
    });
    const saved = await f.readHistory();
    const owner = {
      meetingId: saved.meetingId,
      ownerInstanceId: saved.ownerInstanceId,
      executionVersion: saved.executionVersion,
    };
    const settled = {
      owner,
      outcome: "verified_settled",
      receipt: "generated-independent-settlement",
    };
    const review = {
      scope: "generated-local",
      prefix: fixturePrefix,
      fixture: {
        guildId: f.row.guildId,
        channelId: f.row.channelId,
        meetingId: f.row.meetingId,
        reservedAt: f.row.timestamp,
      },
      history: {
        owner,
        status: saved.status,
        checkpoint: { artifactFolder: saved.checkpoint!.artifactFolder },
        receipt: "generated-terminal-readback",
      },
      capture: settled,
      recovery: settled,
      currentWork: { ...settled, outcome: "active" },
      enumeration: {
        complete: true,
        keys: [...f.objects.keys()],
        receipt: "generated-map-enumeration",
      },
    };
    expect(() => planGeneratedDescendantRemoval(review)).toThrow();
    const count = f.objects.size;
    expect(count).toBeGreaterThan(3);
    const siblingKey = `${fixturePrefix}${f.row.guildId}/other-channel_other-meeting_2026-10-14T12-00-00.000Z/keep.pcm`;
    f.objects.set(siblingKey, Buffer.from("generated sibling meeting"));
    expect(() =>
      planGeneratedDescendantRemoval({
        ...review,
        currentWork: settled,
        enumeration: { ...review.enumeration, keys: [...f.objects.keys()] },
      }),
    ).toThrow("exact generated fixture folder");
    expect(f.objects.size).toBe(count + 1);
    // Synthetic independent settlement receipts authorize only this in-memory fixture operation.
    const plan = planGeneratedDescendantRemoval({
      ...review,
      currentWork: settled,
    });
    expect(plan.liveDeletionAuthorized).toBe(false);
    expect(plan.keys).toEqual(
      expect.arrayContaining([saved.checkpoint!.manifest.key, ...orphanKeys]),
    );
    for (const key of plan.keys) f.objects.delete(key);
    expect([...f.objects.keys()]).toEqual([siblingKey]);
    expect((await f.readHistory()).checkpoint).toEqual(saved.checkpoint);
    expect(await getActiveMeetingLease(f.row.guildId)).toBeDefined();
  } finally {
    config.storage.transcriptPrefix = previousPrefix;
  }
});
