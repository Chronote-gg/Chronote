/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/audio", () => ({
  closeOutputFile: async () => {},
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/commands/endMeeting", () => ({
  fenceMeetingFinalization: (meeting: MeetingData) => {
    meeting.finalizationFenced = true;
  },
}));
let mockVoice: ReturnType<typeof createGuildVoiceOperationService>;
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  ...jest.requireActual("../../src/services/guildVoiceOperationService"),
  prepareOwnedVoiceSession: (
    ...args: Parameters<typeof mockVoice.prepareOwnedVoiceSession>
  ) => mockVoice.prepareOwnedVoiceSession(...args),
  settleOwnedVoiceSession: (
    ...args: Parameters<typeof mockVoice.settleOwnedVoiceSession>
  ) => mockVoice.settleOwnedVoiceSession(...args),
  waitOwnedVoiceEffects: (
    ...args: Parameters<typeof mockVoice.waitOwnedVoiceEffects>
  ) => mockVoice.waitOwnedVoiceEffects(...args),
  whenOwnedVoiceSettled: (
    ...args: Parameters<typeof mockVoice.whenOwnedVoiceSettled>
  ) => mockVoice.whenOwnedVoiceSettled(...args),
}));
let mockRuntime: ReturnType<typeof createRuntimeLifecycle>;
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  ...jest.requireActual("../../src/services/runtimeLifecycleService"),
  beginRuntimeWork: (
    ...args: Parameters<typeof mockRuntime.beginRuntimeWork>
  ) => mockRuntime.beginRuntimeWork(...args),
  getRuntimeAdmissionContext: () => mockRuntime.getRuntimeAdmissionContext(),
}));
let mockRepository: ReturnType<typeof createMockDeploymentControlRepository>;
let mockLeases: Map<string, ActiveMeetingLease>;
let mockLoseDeleteResponse = false;
let mockDeleteBarrier: Promise<void> | undefined;
let mockDeleteFailure = false;
let mockReadFailure = false;
const mockReadLease = jest.fn(async (guildId: string) => {
  if (mockReadFailure) throw new Error("lease read unavailable");
  return mockLeases.get(guildId);
});
const mockReleaseLease = jest.fn(
  async (guildId, meetingId, owner, original) => {
    await mockDeleteBarrier;
    if (mockDeleteFailure) throw new Error("delete failed");
    const lease = mockLeases.get(guildId);
    if (
      !lease ||
      lease.meetingId !== meetingId ||
      lease.ownerInstanceId !== owner ||
      lease.executionVersion !== original.executionVersion ||
      lease.voiceOperationAttemptId !== original.voiceOperationAttemptId
    )
      return false;
    mockLeases.delete(guildId);
    if (mockLoseDeleteResponse) throw new Error("lost delete response");
    return true;
  },
);
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => mockRepository,
  getActiveMeetingLease: (guildId: string) => mockReadLease(guildId),
  renewActiveMeetingLease: async () => true,
  releaseActiveMeetingLease: (
    guildId: string,
    meetingId: string,
    owner: string,
    original: Parameters<typeof mockReleaseLease>[3],
    signal?: AbortSignal,
  ) =>
    leaseDeleteResponse(
      mockReleaseLease(guildId, meetingId, owner, original),
      signal,
    ),
}));
let mockMeeting: MeetingData | undefined;
let mockNickname: string | null;
const mockNicknameMutation = jest.fn(async (nickname: string | null) => {
  mockNickname = nickname;
});
async function mockRestoreNickname(meeting: MeetingData, signal?: AbortSignal) {
  if (!meeting.botNicknameChanged) return true;
  signal?.throwIfAborted();
  await mockNicknameMutation(meeting.botNicknameBeforeSession ?? null);
  meeting.botNicknameChanged = false;
  return true;
}
jest.mock("../../src/meetings", () => ({
  getMeeting: () => mockMeeting,
  deleteMeeting: () => {
    mockMeeting = undefined;
  },
  getPendingMeetingInitializations: () => [],
  restoreVoiceSessionNickname: mockRestoreNickname,
}));
let mockReader: ReturnType<typeof createRecordingCheckpointService>;
jest.mock("../../src/services/recordingCheckpointService", () =>
  jest
    .requireActual("../fixtures/recordingCheckpointEnvironment")
    .createCheckpointServiceOverride(() => mockReader),
);
import type { VoiceBasedChannel } from "discord.js";
import { createVoiceGuild } from "../fixtures/voiceSession";
import { leaseDeleteResponse } from "../fixtures/leaseDeleteResponse";
import { createCheckpointObjectStore } from "../fixtures/recordingCheckpointEnvironment";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";
import { createGuildVoiceOperationService } from "../../src/services/guildVoiceOperationService";
import { createRuntimeLifecycle } from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";
import {
  tryAcquireMeetingLease,
  attachMeetingReservation,
  getOwnedSessionReservations,
} from "../../src/services/activeMeetingLeaseService";
import {
  interruptOwnedMeeting,
  getMeetingInterruptionCheckpoints,
} from "../../src/services/ownedMeetingInterruption";
import { history } from "../deployment/controlFixtures";
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(guildId: string, tts: boolean) {
  mockLeases = new Map();
  const histories = new Map<string, MeetingHistory[]>();
  mockRepository = createMockDeploymentControlRepository(
    new Map(),
    histories,
    mockLeases,
  );
  const identity = {
    kind: "local" as const,
    instanceId: "old",
    localId: "fixture",
    protocolVersion: 1 as const,
  };
  await mockRepository.initializeControl({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "local",
    protocolVersion: 1,
    coordinatorToken: "coordinator",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 2000,
    servingGeneration: 0,
    servingMembers: {},
  });
  mockRuntime = createRuntimeLifecycle({
    identity,
    repository: mockRepository,
    protection: createRuntimeProtectionService({
      identity,
      onUnsafe: jest.fn(),
    }),
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await mockRuntime.start();
  expect(
    await mockRepository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 0,
      expectedServingMembers: [],
      candidate: identity,
      proposedGeneration: 1,
      now: 1000,
    }),
  ).toBe("applied");
  await mockRuntime.getRuntimeAdmissionContext();
  const send = jest.fn(async () => {});
  mockVoice = createGuildVoiceOperationService(mockRepository, () => send);
  const admit = (meetingId: string) =>
    tryAcquireMeetingLease({
      guildId,
      meetingId,
      voiceChannelId: "channel",
      textChannelId: "text",
      isAutoRecording: false,
      reservedAt: Date.now(),
      ...(tts
        ? { sessionMode: "tts_only" as const }
        : {
            sessionMode: "meeting" as const,
            history: {
              ...history,
              guildId,
              meetingId,
              timestamp: new Date(Date.now()).toISOString(),
              channelId_timestamp: "channel#" + meetingId,
            },
          }),
    });
  const admission = await admit("meeting");
  if (admission.kind !== "admitted")
    throw new Error("fixture admission refused");
  const original = admission.reservation;
  const settle = jest.spyOn(original.workHandle, "settle");
  const { client, guild } = createVoiceGuild(guildId);
  const connection = await mockVoice.joinOwnedVoiceSession(original, {
    guild,
    voiceChannel: { id: "channel" } as VoiceBasedChannel,
    captureAudio: false,
    signal: new AbortController().signal,
  });
  const packet = (channel: string | null, sequence: number) =>
    client.emit(
      "raw",
      {
        t: "VOICE_STATE_UPDATE",
        s: sequence,
        d: {
          guild_id: guildId,
          user_id: "bot",
          session_id: "session",
          channel_id: channel,
        },
      },
      0,
    );
  packet("channel", 1);
  const objects = new Map<string, Buffer>();
  mockReader = createRecordingCheckpointService({
    repository: mockRepository,
    objects: createCheckpointObjectStore(objects),
  });
  let row: MeetingHistory | undefined;
  if (original.sessionMode === "meeting") {
    row = histories.get(guildId)![0];
    const capture = {
      ...original.historyKey,
      meetingId: original.meetingId,
      channelId: "channel",
      ownerInstanceId: original.ownerInstanceId,
      executionVersion: 1,
      reservedAt: row.timestamp,
      captureStartedAt: row.timestamp,
      requested: { transcribeMeeting: true, generateNotes: true },
    };
    const checkpoint = await mockReader.flush({
      signal: new AbortController().signal,
      ownership: original,
      capture,
      captureState: { kind: "capturing", startedAt: row.timestamp },
      expectedStatus: "starting",
      artifacts: [],
    });
    expect(checkpoint.kind).toBe("committed");
    Object.assign(row, {
      status: "complete",
      notes: "Delivered original notes",
      notesVersion: 4,
      notesMessageId: "original-message",
      transcriptS3Key: "saved-transcript",
      audioS3Key: "saved-audio",
      archivedAt: "2026-10-30T00:00:00.000Z",
      recovery: { disposition: "done", executionVersion: 1, stage: "delivery" },
    });
  }
  const local = held();
  const ai = jest.fn(async () => "Delivered original notes");
  const post = jest.fn(async () => "original-message");
  const exportNotion = jest.fn(async () => {});
  const finalizer = jest.fn(async () => {
    await ai();
    await post();
    await exportNotion();
  });
  const meeting = {
    guildId,
    meetingId: "meeting",
    reservation: original,
    voiceChannel: { id: "channel" },
    transcribeMeeting: true,
    generateNotes: true,
    captureStartedAt: new Date(original.reservedAt),
    audioData: {},
    recordingContentTask: local.promise,
    finalization: {
      promise: finalizer(),
      disposition: "durable",
      controller: new AbortController(),
    },
    setFinished: jest.fn(),
    recordingCapture: {
      pending: () => [],
      settled: async () => {},
      releaseSettledBuffers: jest.fn(),
    },
  } as unknown as MeetingData;
  mockMeeting = meeting;
  attachMeetingReservation(meeting, original);
  return {
    original,
    settle,
    meeting,
    local,
    row,
    objects,
    finalizer,
    ai,
    post,
    exportNotion,
    packet,
    connection,
    send,
    admit,
  };
}
beforeEach(() => {
  jest.useFakeTimers({ now: 1000000 });
  mockReleaseLease.mockClear();
  mockLoseDeleteResponse = false;
  mockDeleteBarrier = undefined;
  mockDeleteFailure = false;
  mockReadFailure = false;
  mockReadLease.mockClear();
  mockNicknameMutation.mockClear();
  mockNickname = "session nickname";
  jest.spyOn(console, "info").mockImplementation(() => {});
});

async function holdCleanupAfterStop(f: Awaited<ReturnType<typeof fixture>>) {
  f.local.resolve();
  const stop = interruptOwnedMeeting(f.meeting, {
    reason: "processing_failure",
    deadline: Date.now() + 10000,
  });
  await jest.advanceTimersByTimeAsync(10000);
  expect(await stop).toEqual({ kind: "unresolved" });
  const deletion = held();
  mockDeleteBarrier = deletion.promise;
  return deletion;
}

describe.each(["meeting", "tts_only"] as const)(
  "%s nickname cleanup",
  (mode) => {
    test.each([
      "current",
      "foreign_remote",
      "expired",
      "expiry_boundary",
      "missing",
    ])(
      "requires the current original lease before mutation: %s",
      async (authority) => {
        const f = await fixture(
          "nickname-" + mode + authority,
          mode === "tts_only",
        );
        const canonical = f.row && structuredClone(f.row);
        const deletion = await holdCleanupAfterStop(f);
        const lease = mockLeases.get(f.original.guildId)!;
        if (authority === "foreign_remote") {
          mockLeases.set(f.original.guildId, {
            ...lease,
            meetingId: "newer",
            ownerInstanceId: "new-runtime",
            voiceOperationAttemptId: "newer-voice",
            executionVersion: 2,
          });
          mockNickname = "newer session nickname";
        }
        if (authority === "expired")
          lease.leaseExpiresAt = Math.floor(Date.now() / 1000) - 1;
        if (authority === "expiry_boundary")
          lease.leaseExpiresAt = Math.floor(Date.now() / 1000);
        if (authority === "missing") mockLeases.delete(f.original.guildId);
        const nicknameBeforeCleanup = mockNickname;
        const leaseBeforeCleanup = mockLeases.get(f.original.guildId);
        f.meeting.botNicknameChanged = true;
        f.meeting.botNicknameBeforeSession = "original nickname";
        f.packet(null, 2);
        await jest.advanceTimersByTimeAsync(0);
        const permitted = authority === "current";
        const expectedCalls = permitted ? 1 : 0;
        expect(mockNicknameMutation).toHaveBeenCalledTimes(expectedCalls);
        expect(mockNickname).toBe(
          permitted ? "original nickname" : nicknameBeforeCleanup,
        );
        expect(f.meeting.botNicknameChanged).toBe(!permitted);
        await jest.advanceTimersByTimeAsync(30001);
        expect(f.settle).not.toHaveBeenCalled();
        deletion.resolve();
        await jest.advanceTimersByTimeAsync(0);
        expect(f.settle).toHaveBeenCalledTimes(expectedCalls);
        expect(f.meeting.setFinished).toHaveBeenCalledTimes(expectedCalls);
        expect(mockReleaseLease).toHaveBeenCalledTimes(expectedCalls);
        expect(mockNicknameMutation).toHaveBeenCalledTimes(expectedCalls);
        expect(
          mockRuntime.getWorkCounts()[
            mode === "tts_only" ? "voice_operation" : "recording"
          ],
        ).toBe(permitted ? 0 : 1);
        if (!permitted)
          expect(mockLeases.get(f.original.guildId)).toBe(leaseBeforeCleanup);
        expect(f.row).toEqual(canonical);
      },
    );
  },
);

describe.each(["failed", "interrupted"] as const)(
  "%s preservation",
  (status) => {
    test.each([
      "unchanged",
      "missing_manifest",
      "changed_checkpoint",
      "changed_status",
      "newer_owner",
      "unknown_readback",
    ])(
      "verifies late deletion without repeating preservation: %s",
      async (condition) => {
        const f = await fixture("terminal-delete-" + status + condition, false);
        f.row!.status = status;
        f.row!.recovery = {
          disposition: "pending",
          executionVersion: 1,
          attempt: 0,
          stage: "verification",
          retry: { maxAttempts: 3, nextAttemptAt: null },
        };
        const deletion = await holdCleanupAfterStop(f);
        const writes = jest.spyOn(mockRepository, "transitionMeetingHistory");
        f.packet(null, 2);
        await jest.advanceTimersByTimeAsync(0);
        expect(mockReleaseLease).toHaveBeenCalledTimes(1);
        expect(writes).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(30001);
        expect(f.settle).not.toHaveBeenCalled();
        expect(mockRuntime.getWorkCounts().recording).toBe(1);
        if (condition === "missing_manifest")
          f.objects.delete(f.row!.checkpoint!.manifest.key);
        if (condition === "changed_checkpoint")
          f.row!.checkpoint!.revision += 1;
        if (condition === "changed_status") f.row!.status = "complete";
        if (condition === "newer_owner")
          mockLeases.set(f.original.guildId, {
            ...mockLeases.get(f.original.guildId)!,
            meetingId: "newer",
            voiceOperationAttemptId: "newer-voice",
            executionVersion: 2,
          });
        mockReadFailure = condition === "unknown_readback";
        const canonical = structuredClone(f.row);
        deletion.resolve();
        await jest.advanceTimersByTimeAsync(0);
        const released = condition === "unchanged";
        expect(f.settle).toHaveBeenCalledTimes(released ? 1 : 0);
        expect(f.meeting.setFinished).toHaveBeenCalledTimes(released ? 1 : 0);
        expect(mockRuntime.getWorkCounts().recording).toBe(released ? 0 : 1);
        expect(mockReleaseLease).toHaveBeenCalledTimes(1);
        expect(writes).toHaveBeenCalledTimes(1);
        expect(f.row).toEqual(canonical);
        const reads = mockReadLease.mock.calls.length;
        await jest.advanceTimersByTimeAsync(60000);
        expect(mockReadLease).toHaveBeenCalledTimes(reads);
        expect(writes).toHaveBeenCalledTimes(1);
        if (released) expect((await f.admit("next")).kind).toBe("admitted");
      },
    );
  },
);
afterEach(() => {
  mockRuntime?.stop();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
test.each([
  "complete",
  "late_work",
  "tts",
  "newer_owner",
  "lost_delete_response",
  "late_delete",
])(
  "actual SDK, lease and runtime counts release exact original after late ACK: %s",
  async (scenario) => {
    const f = await fixture("late-" + scenario, scenario === "tts");
    const canonical = f.row && structuredClone(f.row);
    const workKind = scenario === "tts" ? "voice_operation" : "recording";
    const unrelated = mockRuntime.beginRuntimeWork("ancillary_delivery");
    if (scenario !== "late_work") f.local.resolve();
    const stop = interruptOwnedMeeting(f.meeting, {
      reason: "processing_failure",
      deadline: Date.now() + 10000,
    });
    await jest.advanceTimersByTimeAsync(10000);
    expect(await mockVoice.settleOwnedVoiceSession(f.original)).toBe(
      "uncertain",
    );
    expect(await stop).toEqual({ kind: "unresolved" });
    expect(f.meeting.finished).not.toBe(true);
    expect(mockRuntime.getWorkCounts()[workKind]).toBe(1);
    mockLoseDeleteResponse = scenario === "lost_delete_response";
    const deletion = held();
    if (scenario === "late_delete") mockDeleteBarrier = deletion.promise;
    let newer: ActiveMeetingLease | undefined;
    let newerWork: ReturnType<typeof mockRuntime.beginRuntimeWork> | undefined;
    if (scenario === "newer_owner") {
      newerWork = mockRuntime.beginRuntimeWork("recording");
      newer = {
        ...mockLeases.get(f.original.guildId)!,
        meetingId: "newer",
        voiceOperationAttemptId: "newer-voice",
        executionVersion: 2,
      };
      mockLeases.set(f.original.guildId, newer);
      mockMeeting = {
        guildId: f.original.guildId,
        meetingId: "newer",
        setFinished: jest.fn(),
      } as unknown as MeetingData;
    }
    f.packet("channel", 2);
    f.packet(null, 3);
    await jest.advanceTimersByTimeAsync(0);
    if (scenario === "late_delete") {
      expect(mockReleaseLease).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30001);
      expect(f.meeting.finished).not.toBe(true);
      expect(mockLeases.has(f.original.guildId)).toBe(true);
      expect(mockRuntime.getWorkCounts()[workKind]).toBe(1);
      expect(f.settle).not.toHaveBeenCalled();
      deletion.resolve();
      await jest.advanceTimersByTimeAsync(0);
    }
    if (scenario === "late_work") {
      await jest.advanceTimersByTimeAsync(30000);
      expect(f.meeting.finished).not.toBe(true);
      expect(mockReleaseLease).not.toHaveBeenCalled();
      f.local.resolve();
      await jest.advanceTimersByTimeAsync(0);
    }
    if (scenario === "newer_owner") {
      expect(f.meeting.finished).not.toBe(true);
      expect(mockLeases.get(f.original.guildId)).toBe(newer);
      expect(mockRuntime.getWorkCounts()[workKind]).toBe(2);
      expect(mockReleaseLease).not.toHaveBeenCalled();
      expect(mockMeeting!.setFinished).not.toHaveBeenCalled();
    } else {
      expect(f.meeting.finished).toBe(true);
      expect(mockRuntime.getWorkCounts()[workKind]).toBe(0);
      expect(mockRuntime.getWorkCounts().ancillary_delivery).toBe(1);
      expect(mockReleaseLease).toHaveBeenCalledTimes(1);
      expect(f.meeting.setFinished).toHaveBeenCalledTimes(1);
      expect(
        getOwnedSessionReservations().some(
          (entry) => entry.reservation === f.original,
        ),
      ).toBe(false);
      expect(
        getMeetingInterruptionCheckpoints().some(
          (entry) => entry.meeting === f.meeting,
        ),
      ).toBe(false);
      const next = await f.admit("next");
      expect(next.kind).toBe("admitted");
      if (next.kind === "admitted")
        attachMeetingReservation(
          { guildId: f.original.guildId, meetingId: "next" } as MeetingData,
          next.reservation,
        );
      expect(mockRuntime.getWorkCounts()[workKind]).toBe(1);
    }
    f.packet(null, 4);
    await jest.advanceTimersByTimeAsync(0);
    expect(f.settle).toHaveBeenCalledTimes(scenario === "newer_owner" ? 0 : 1);
    expect(f.finalizer).toHaveBeenCalledTimes(1);
    expect(f.ai).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.exportNotion).toHaveBeenCalledTimes(1);
    expect(mockReleaseLease).toHaveBeenCalledTimes(
      scenario === "newer_owner" ? 0 : 1,
    );
    expect(f.meeting.setFinished).toHaveBeenCalledTimes(
      scenario === "newer_owner" ? 0 : 1,
    );
    expect(f.row).toEqual(canonical);
    expect(f.connection.state.status).toBe("destroyed");
    expect(f.connection.rejoin()).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(2);
    unrelated.settle();
    newerWork?.settle();
  },
);

test.each(["lost_response", "failed", "unreadable", "newer_owner", "tts"])(
  "late cleanup completion verifies once without replaying a delete: %s",
  async (outcome) => {
    const f = await fixture("late-delete-" + outcome, outcome === "tts");
    const canonical = f.row && structuredClone(f.row);
    const workKind = outcome === "tts" ? "voice_operation" : "recording";
    const deletion = await holdCleanupAfterStop(f);
    f.packet(null, 2);
    await jest.advanceTimersByTimeAsync(0);
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(30001);
    expect(mockRuntime.getWorkCounts()[workKind]).toBe(1);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.meeting.finished).not.toBe(true);

    mockLoseDeleteResponse = outcome === "lost_response";
    mockDeleteFailure = outcome === "failed";
    mockReadFailure = outcome === "unreadable";
    const newer = {
      ...mockLeases.get(f.original.guildId)!,
      meetingId: "newer",
      voiceOperationAttemptId: "newer-voice",
      executionVersion: 2,
    };
    const newerWork =
      outcome === "newer_owner"
        ? mockRuntime.beginRuntimeWork("recording")
        : undefined;
    if (newerWork) mockLeases.set(f.original.guildId, newer);
    const readsBeforeCompletion = mockReadLease.mock.calls.length;
    deletion.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockReadLease.mock.calls.length).toBeGreaterThan(
      readsBeforeCompletion,
    );

    const released = outcome === "lost_response" || outcome === "tts";
    expect(f.settle).toHaveBeenCalledTimes(released ? 1 : 0);
    expect(f.meeting.setFinished).toHaveBeenCalledTimes(released ? 1 : 0);
    expect(mockRuntime.getWorkCounts()[workKind]).toBe(
      released ? 0 : newerWork ? 2 : 1,
    );
    if (newerWork) expect(mockLeases.get(f.original.guildId)).toBe(newer);
    if (outcome === "failed")
      expect(mockLeases.get(f.original.guildId)?.meetingId).toBe("meeting");
    if (outcome === "unreadable")
      expect(mockLeases.has(f.original.guildId)).toBe(false);
    const reads = mockReadLease.mock.calls.length;
    f.packet(null, 3);
    await jest.advanceTimersByTimeAsync(60000);
    expect(mockReadLease).toHaveBeenCalledTimes(reads);
    expect(mockReleaseLease).toHaveBeenCalledTimes(1);
    expect(f.row).toEqual(canonical);
    expect(f.finalizer).toHaveBeenCalledTimes(1);
    expect(f.ai).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.exportNotion).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.connection.state.status).toBe("destroyed");
    newerWork?.settle();
  },
);
