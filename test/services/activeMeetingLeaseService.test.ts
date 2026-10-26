/** @jest-environment node */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";
jest.mock("dotenv", () => ({ config: jest.fn() }));
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
  requestMeetingEndViaLease,
  releaseMeetingLeaseByIdentifiers,
  releaseMeetingLeaseForMeeting,
  startMeetingLeaseHeartbeat,
  tryAcquireMeetingLease,
  unwindSessionInitialization,
  getOwnedSessionReservations,
  releaseSessionReservation,
  reconcilePreservedRecordingReservation,
  reconcilePreservedTtsReservation,
  attachMeetingReservation,
  isReservationControlEligible,
} from "../../src/services/activeMeetingLeaseService";
import {
  getActiveMeetingLease,
  requestActiveMeetingEnd,
  releaseActiveMeetingLease,
  renewActiveMeetingLease,
  getDeploymentControlRepository,
  transitionMeetingHistory,
} from "../../src/db";
import { MEETING_END_REASONS } from "../../src/types/meetingLifecycle";
import { settleOwnedVoiceSession } from "../../src/services/guildVoiceOperationService";
import { randomUUID } from "node:crypto";

jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  requestActiveMeetingEnd: jest.fn(),
  releaseActiveMeetingLease: jest.fn(),
  renewActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: jest.fn(),
  transitionMeetingHistory: jest.fn(),
}));

import {
  beginRuntimeWork,
  getRuntimeAdmissionContext,
} from "../../src/services/runtimeLifecycleService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(() => ({
    settle: jest.fn(),
    transition: jest.fn(),
  })),
  getRuntimeAdmissionContext: jest.fn(async () => ({
    instanceId: "instance-1",
    identity: {
      kind: "local",
      localId: "fixture",
      instanceId: "instance-1",
      protocolVersion: 1,
    },
    authorizedGeneration: 1,
    observedEpoch: 1,
    protocolVersion: 1,
    now: Math.floor(Date.now() / 1000),
  })),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  prepareOwnedVoiceSession: jest.fn(),
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "instance-1",
}));

describe("activeMeetingLeaseService", () => {
  const mockedGetActiveMeetingLease = jest.mocked(getActiveMeetingLease);
  const mockedRequestActiveMeetingEnd = jest.mocked(requestActiveMeetingEnd);
  const mockedReleaseActiveMeetingLease = jest.mocked(
    releaseActiveMeetingLease,
  );
  const mockedRenewActiveMeetingLease = jest.mocked(renewActiveMeetingLease);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-02-14T20:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function recordingReservation() {
    const id = randomUUID();
    const getMeetingHistory =
      jest.fn<
        ReturnType<typeof getDeploymentControlRepository>["getMeetingHistory"]
      >();
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      reserveSession: jest.fn(async () => ({ kind: "admitted" as const })),
      getMeetingHistory,
    } as unknown as ReturnType<typeof getDeploymentControlRepository>);
    mockedRenewActiveMeetingLease.mockResolvedValue(true);
    mockedReleaseActiveMeetingLease.mockResolvedValue(true);
    const admitted = await tryAcquireMeetingLease({
      guildId: id,
      meetingId: id,
      voiceChannelId: "voice",
      textChannelId: "text",
      isAutoRecording: false,
      sessionMode: "meeting",
      reservedAt: Date.now(),
      history: {
        guildId: id,
        meetingId: id,
        channelId_timestamp: "voice#start",
        channelId: "voice",
        timestamp: "start",
        participants: [],
        duration: 0,
        transcribeMeeting: true,
        generateNotes: true,
      },
    });
    if (admitted.kind !== "admitted")
      throw new Error("fixture admission failed");
    return { reservation: admitted.reservation, getMeetingHistory };
  }

  test("actual recording reservation binds canonical capability to its execution", async () => {
    const { reservation } = await recordingReservation();
    expect(
      getDeploymentControlRepository().reserveSession,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        history: expect.objectContaining({
          canonicalWriter: {
            kind: "recording",
            ownerInstanceId: reservation.ownerInstanceId,
            executionVersion: reservation.executionVersion,
          },
        }),
      }),
    );
  });

  test.each(["absent", "newer", "initialization_unknown"] as const)(
    "TTS reconciliation requires original lease and actual cleanup: %s",
    async (remote) => {
      const getMeetingHistory = jest.fn();
      jest.mocked(getDeploymentControlRepository).mockReturnValue({
        reserveSession: jest.fn(async () => ({ kind: "admitted" })),
        getMeetingHistory,
      } as unknown as ReturnType<typeof getDeploymentControlRepository>);
      const id = randomUUID();
      const result = await tryAcquireMeetingLease({
        guildId: id,
        meetingId: id,
        voiceChannelId: "voice",
        textChannelId: "text",
        isAutoRecording: false,
        sessionMode: "tts_only",
        reservedAt: Date.now(),
      });
      if (
        result.kind !== "admitted" ||
        result.reservation.sessionMode !== "tts_only"
      )
        throw new Error("Fixture admission failed");
      const reservation = result.reservation;
      if (remote === "initialization_unknown")
        await unwindSessionInitialization(reservation, Promise.resolve(false));
      mockedGetActiveMeetingLease.mockResolvedValue(
        remote === "newer"
          ? {
              ...reservation,
              ownerInstanceId: "newer-owner",
              executionVersion: 2,
              voiceChannelId: "voice",
              textChannelId: "text",
              isAutoRecording: false,
              leaseExpiresAt: 9999999999,
              createdAt: new Date(Date.now()).toISOString(),
              updatedAt: new Date(Date.now()).toISOString(),
              expiresAt: 9999999999 + 120,
            }
          : undefined,
      );
      let release!: () => void;
      const localWork = new Promise<void>((resolve) => {
        release = resolve;
      });
      const proof = {
        localWork,
        signal: new AbortController().signal,
        deadline: Date.now() + 100000,
        ancillarySettled: true,
      };
      expect(
        await reconcilePreservedTtsReservation(
          { ...reservation },
          { ...proof, localWork: Promise.resolve() },
        ),
      ).toBe(false);
      const reconciling = reconcilePreservedTtsReservation(reservation, proof);
      await Promise.resolve();
      expect(reservation.workHandle.settle).not.toHaveBeenCalled();
      expect(mockedGetActiveMeetingLease).not.toHaveBeenCalled();
      release();
      expect(await reconciling).toBe(remote === "absent");
      expect(reservation.workHandle.settle).toHaveBeenCalledTimes(
        remote === "absent" ? 1 : 0,
      );
      expect(mockedReleaseActiveMeetingLease).not.toHaveBeenCalled();
      expect(getMeetingHistory).not.toHaveBeenCalled();
    },
  );

  test("reservation exposes the actual held renewal before meeting initialization", async () => {
    const { reservation } = await recordingReservation();
    let complete!: (value: boolean) => void;
    mockedRenewActiveMeetingLease.mockImplementationOnce(
      () =>
        new Promise((done) => {
          complete = done;
        }),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    const owned = getOwnedSessionReservations().find(
      (entry) => entry.reservation === reservation,
    )!;
    expect(owned.renewal).toBeDefined();
    let settled = false;
    void owned.renewal!.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    complete(true);
    await owned.renewal;
    expect(settled).toBe(true);
    expect(
      getOwnedSessionReservations().find(
        (entry) => entry.reservation === reservation,
      )?.renewal,
    ).toBeUndefined();
    await releaseSessionReservation(reservation);
  });

  test("a control fenced during admission lookup cannot reserve or prepare voice", async () => {
    const context = await getRuntimeAdmissionContext();
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    jest.mocked(getRuntimeAdmissionContext).mockImplementationOnce(async () => {
      enter();
      await held;
      return context;
    });
    const reserveSession = jest.fn(async () => ({ kind: "admitted" as const }));
    jest
      .mocked(getDeploymentControlRepository)
      .mockReturnValue({ reserveSession } as unknown as ReturnType<
        typeof getDeploymentControlRepository
      >);
    const controller = new AbortController();
    const acquisition = tryAcquireMeetingLease({
      guildId: randomUUID(),
      meetingId: randomUUID(),
      voiceChannelId: "voice",
      textChannelId: "text",
      isAutoRecording: false,
      sessionMode: "tts_only",
      reservedAt: Date.now(),
      startSignal: controller.signal,
      assertStartAllowed: async () => controller.signal.throwIfAborted(),
    });
    await started;
    controller.abort(new Error("control claim lost"));
    release();
    expect(await acquisition).toEqual({
      kind: "blocked",
      reason: "not_serving",
    });
    expect(reserveSession).not.toHaveBeenCalled();
    const { prepareOwnedVoiceSession } =
      await import("../../src/services/guildVoiceOperationService");
    expect(prepareOwnedVoiceSession).not.toHaveBeenCalled();
    const pendingWork = jest.mocked(beginRuntimeWork).mock.results[0];
    if (pendingWork?.type !== "return")
      throw new Error("Expected pending admission work handle");
    expect(pendingWork.value.settle).toHaveBeenCalledTimes(1);
  });

  test.each([
    "remote_stop",
    "status_read_failure",
    "status_read_timeout",
    "ownership_lost",
    "renewal_error",
  ])("reservation handles %s without weakening ownership", async (scenario) => {
    const { reservation } = await recordingReservation();
    let finish!: () => void;
    const end = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const meeting = {
      guildId: reservation.guildId,
      meetingId: reservation.meetingId,
      reservation,
      finishing: false,
      finished: false,
      onEndMeeting: jest.fn(async () => {
        meeting.finishing = true;
        await end;
      }),
    } as unknown as MeetingData;
    attachMeetingReservation(meeting, reservation);
    const ownershipUnconfirmed =
      scenario === "ownership_lost" || scenario === "renewal_error";
    if (scenario === "ownership_lost") {
      mockedRenewActiveMeetingLease.mockResolvedValueOnce(false);
    } else if (scenario === "renewal_error") {
      mockedRenewActiveMeetingLease.mockRejectedValueOnce(
        new Error("fixture renewal unavailable"),
      );
    } else if (scenario === "status_read_timeout") {
      jest.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), delay);
        return controller.signal;
      });
      mockedGetActiveMeetingLease.mockImplementationOnce(
        async (_guildId, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      mockedGetActiveMeetingLease.mockResolvedValue(undefined);
    } else if (scenario === "status_read_failure") {
      mockedGetActiveMeetingLease
        .mockRejectedValueOnce(new Error("fixture status read unavailable"))
        .mockResolvedValue(undefined);
    } else {
      mockedGetActiveMeetingLease.mockResolvedValue({
        endRequestedAt: "now",
        endRequestedByUserId: "operator",
      } as never);
    }
    const before = mockedRenewActiveMeetingLease.mock.calls.length;
    await jest.advanceTimersByTimeAsync(50_000);
    expect(mockedRenewActiveMeetingLease.mock.calls.length - before).toBe(
      ownershipUnconfirmed ? 1 : 5,
    );
    expect(meeting.onEndMeeting).toHaveBeenCalledTimes(
      scenario.startsWith("status_read_") ? 0 : 1,
    );
    expect(meeting.ownershipSignal?.aborted).toBe(ownershipUnconfirmed);
    finish();
    await releaseSessionReservation(reservation);
  });

  test("fence during actual lease deletion retains the work handle", async () => {
    const { reservation } = await recordingReservation();
    const meeting = {
      reservation,
      finalization: {
        disposition: "durable",
        controller: new AbortController(),
      },
    } as unknown as MeetingData;
    attachMeetingReservation(meeting, reservation);
    let finish!: () => void;
    mockedReleaseActiveMeetingLease.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return true;
    });
    const releasing = releaseSessionReservation(reservation);
    await Promise.resolve();
    await Promise.resolve();
    expect(isReservationControlEligible(reservation)).toBe(false);
    meeting.finalizationFenced = true;
    finish();
    expect(await releasing).toBe(false);
    expect(reservation.workHandle.settle).not.toHaveBeenCalled();
    expect(getOwnedSessionReservations()).toContainEqual(
      expect.objectContaining({ reservation }),
    );
  });
  test.each([true, false])(
    "delete-applied reconciliation requires terminal checkpoint proof: %s",
    async (terminalProof) => {
      const { reservation, getMeetingHistory } = await recordingReservation();
      if (reservation.sessionMode !== "meeting")
        throw new Error("fixture mode");
      const meeting = {
        reservation,
        finalization: {
          disposition: "durable",
          controller: new AbortController(),
        },
      } as unknown as MeetingData;
      attachMeetingReservation(meeting, reservation);
      let completeDelete!: () => void;
      mockedReleaseActiveMeetingLease.mockImplementationOnce(async () => {
        await new Promise<void>((done) => {
          completeDelete = done;
        });
        return true;
      });
      const deleting = releaseSessionReservation(reservation);
      await Promise.resolve();
      await Promise.resolve();
      meeting.finalizationFenced = true;
      completeDelete();
      expect(await deleting).toBe(false);
      const checkpoint = {
        revision: 1,
        capture: {
          guildId: reservation.guildId,
          meetingId: reservation.meetingId,
          ownerInstanceId: reservation.ownerInstanceId,
          executionVersion: reservation.executionVersion,
        },
      } as import("../../src/types/recordingCheckpoint").RecordingCheckpoint;
      getMeetingHistory.mockResolvedValue({
        guildId: reservation.guildId,
        meetingId: reservation.meetingId,
        ownerInstanceId: reservation.ownerInstanceId,
        executionVersion: reservation.executionVersion,
        status: terminalProof ? "complete" : "processing",
        checkpoint,
      } as import("../../src/types/db").MeetingHistory);
      mockedGetActiveMeetingLease.mockResolvedValue(undefined);
      const signal = new AbortController().signal;
      const released = await reconcilePreservedRecordingReservation(
        reservation,
        {
          checkpoint,
          status: "complete",
          localWork: Promise.resolve(),
          signal,
          deadline: Date.now() + 100000,
        },
      );
      expect(released).toBe(terminalProof);
      expect(reservation.workHandle.settle).toHaveBeenCalledTimes(
        terminalProof ? 1 : 0,
      );
      expect(mockedReleaseActiveMeetingLease).toHaveBeenCalledTimes(1);
    },
  );

  test("rejected history unwind retains counted ownership but still settles voice", async () => {
    const { reservation, getMeetingHistory } = await recordingReservation();
    jest
      .mocked(transitionMeetingHistory)
      .mockRejectedValue(new Error("fixture storage unavailable"));
    getMeetingHistory.mockRejectedValue(new Error("fixture read unavailable"));
    await unwindSessionInitialization(reservation);
    expect(settleOwnedVoiceSession).toHaveBeenCalledWith(reservation);
    expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
    expect(reservation.workHandle.settle).not.toHaveBeenCalled();
    expect(
      getOwnedSessionReservations().map((entry) => entry.reservation),
    ).toContain(reservation);
  });

  test("applied initial progress with lost response reconciles exact in_progress before release", async () => {
    const { reservation, getMeetingHistory } = await recordingReservation();
    jest
      .mocked(transitionMeetingHistory)
      .mockResolvedValueOnce("stale")
      .mockResolvedValueOnce("applied");
    getMeetingHistory.mockResolvedValue({
      guildId: reservation.guildId,
      meetingId: reservation.meetingId,
      ownerInstanceId: reservation.ownerInstanceId,
      executionVersion: reservation.executionVersion,
      status: "in_progress",
    } as Awaited<
      ReturnType<
        ReturnType<typeof getDeploymentControlRepository>["getMeetingHistory"]
      >
    >);
    await unwindSessionInitialization(reservation);
    expect(transitionMeetingHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedStatus: "in_progress",
        expectedOwnerInstanceId: reservation.ownerInstanceId,
        expectedExecutionVersion: 1,
        patch: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(reservation.workHandle.settle).toHaveBeenCalledTimes(1);
  });

  test("stale history owned by a newer attempt cannot be changed or released", async () => {
    const { reservation, getMeetingHistory } = await recordingReservation();
    jest.mocked(transitionMeetingHistory).mockResolvedValue("stale");
    getMeetingHistory.mockResolvedValue({
      guildId: reservation.guildId,
      meetingId: reservation.meetingId,
      ownerInstanceId: "new-owner",
      executionVersion: 2,
      status: "in_progress",
    } as Awaited<
      ReturnType<
        ReturnType<typeof getDeploymentControlRepository>["getMeetingHistory"]
      >
    >);
    await unwindSessionInitialization(reservation);
    expect(transitionMeetingHistory).toHaveBeenCalledTimes(1);
    expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
    expect(reservation.workHandle.settle).not.toHaveBeenCalled();
  });
  test("unresolved encoder cleanup retains ownership after voice and history settle", async () => {
    const { reservation } = await recordingReservation();
    jest.mocked(transitionMeetingHistory).mockResolvedValue("applied");
    await unwindSessionInitialization(reservation, Promise.resolve(false));
    await unwindSessionInitialization(reservation);
    expect(settleOwnedVoiceSession).toHaveBeenCalledWith(reservation);
    expect(await releaseSessionReservation(reservation)).toBe(false);
    expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
    expect(reservation.workHandle.settle).not.toHaveBeenCalled();
    expect(getOwnedSessionReservations()).toContainEqual(
      expect.objectContaining({ reservation, initializationUnresolved: true }),
    );
  });
  test("terminal checkpoint cannot erase earlier failed initialization cleanup", async () => {
    const { reservation, getMeetingHistory } = await recordingReservation();
    if (reservation.sessionMode !== "meeting") throw new Error("fixture mode");
    jest.mocked(transitionMeetingHistory).mockResolvedValue("applied");
    await unwindSessionInitialization(reservation, Promise.resolve(false));
    const checkpoint = {
      revision: 1,
    } as import("../../src/types/recordingCheckpoint").RecordingCheckpoint;
    getMeetingHistory.mockResolvedValue({
      guildId: reservation.guildId,
      meetingId: reservation.meetingId,
      ownerInstanceId: reservation.ownerInstanceId,
      executionVersion: reservation.executionVersion,
      status: "complete",
      checkpoint,
    } as import("../../src/types/db").MeetingHistory);
    mockedGetActiveMeetingLease.mockResolvedValue(undefined);
    const released = await reconcilePreservedRecordingReservation(reservation, {
      checkpoint,
      status: "complete",
      localWork: Promise.resolve(),
      signal: new AbortController().signal,
      deadline: Date.now() + 100_000,
    });
    expect(released).toBe(false);
    expect(reservation.workHandle.settle).not.toHaveBeenCalled();
    expect(getOwnedSessionReservations()).toContainEqual(
      expect.objectContaining({ reservation, initializationUnresolved: true }),
    );
  });

  test("lost failed-transition response is established by exact failed readback", async () => {
    const { reservation, getMeetingHistory } = await recordingReservation();
    jest
      .mocked(transitionMeetingHistory)
      .mockRejectedValueOnce(new Error("fixture response lost"));
    getMeetingHistory.mockResolvedValue({
      guildId: reservation.guildId,
      meetingId: reservation.meetingId,
      ownerInstanceId: reservation.ownerInstanceId,
      executionVersion: 1,
      status: "failed",
    } as Awaited<
      ReturnType<
        ReturnType<typeof getDeploymentControlRepository>["getMeetingHistory"]
      >
    >);
    await unwindSessionInitialization(reservation);
    expect(transitionMeetingHistory).toHaveBeenCalledTimes(1);
    expect(reservation.workHandle.settle).toHaveBeenCalledTimes(1);
  });

  test("reservationHeartbeatsBeforeInitialization and synchronous pending work", async () => {
    const reserveSession = jest
      .fn<ReturnType<typeof getDeploymentControlRepository>["reserveSession"]>()
      .mockResolvedValue({ kind: "admitted" });
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      ...createMockDeploymentControlRepository(),
      reserveSession,
    });
    mockedRenewActiveMeetingLease.mockResolvedValue(true);
    const resultPromise = tryAcquireMeetingLease({
      guildId: "reserved-guild",
      meetingId: "reserved-meeting",
      voiceChannelId: "voice",
      textChannelId: "text",
      isAutoRecording: false,
      sessionMode: "tts_only",
      reservedAt: Date.now(),
    });
    expect(beginRuntimeWork).toHaveBeenCalledWith("pending_admission");
    const result = await resultPromise;
    expect(result.kind).toBe("admitted");
    expect(mockedRenewActiveMeetingLease.mock.calls.length).toBeGreaterThan(0);
    expect(reserveSession).toHaveBeenCalledWith(
      expect.objectContaining({
        history: undefined,
        lease: expect.objectContaining({
          executionVersion: 1,
          sessionMode: "tts_only",
          leaseExpiresAt: Math.floor(Date.now() / 1000) + 30,
        }),
      }),
    );
  });

  test("reports active lease status by epoch seconds", () => {
    expect(
      isLeaseActive({
        guildId: "guild-1",
        meetingId: "meeting-1",
        ownerInstanceId: "instance-1",
        voiceChannelId: "voice-1",
        textChannelId: "text-1",
        isAutoRecording: false,
        leaseExpiresAt: 1771102800,
        createdAt: "2026-02-14T20:00:00.000Z",
        updatedAt: "2026-02-14T20:00:00.000Z",
        expiresAt: 1771102950,
      }),
    ).toBe(true);
    expect(
      isLeaseActive(
        {
          guildId: "guild-1",
          meetingId: "meeting-1",
          ownerInstanceId: "instance-1",
          voiceChannelId: "voice-1",
          textChannelId: "text-1",
          isAutoRecording: false,
          leaseExpiresAt: 1771102799,
          createdAt: "2026-02-14T20:00:00.000Z",
          updatedAt: "2026-02-14T20:00:00.000Z",
          expiresAt: 1771102950,
        },
        1771102800,
      ),
    ).toBe(false);
  });

  test("renews lease on heartbeat and ends meeting if ownership is lost", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });
    mockedRenewActiveMeetingLease
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const onEndMeeting = jest.fn<() => Promise<void>>().mockResolvedValue();

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: false,
      onEndMeeting,
      endReason: undefined,
      textChannel: {
        send: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      },
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(20_000);

    expect(mockedRenewActiveMeetingLease).toHaveBeenCalled();
    expect(onEndMeeting).toHaveBeenCalledTimes(1);
  });

  test("releases lease by meeting object and clears heartbeat timer", async () => {
    mockedReleaseActiveMeetingLease.mockResolvedValue(true);
    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      leaseHeartbeatTimer: setInterval(() => undefined, 60_000),
    } as unknown as MeetingData;

    const released = await releaseMeetingLeaseForMeeting(meeting);

    expect(released).toBe(true);
    expect(meeting.leaseHeartbeatTimer).toBeUndefined();
    expect(mockedReleaseActiveMeetingLease).toHaveBeenCalledWith(
      "guild-1",
      "meeting-1",
      "instance-1",
    );
  });

  test("passes through simple read and delete helpers", async () => {
    mockedGetActiveMeetingLease.mockImplementation(async () => undefined);
    mockedReleaseActiveMeetingLease.mockResolvedValue(true);

    const lease = await getActiveMeetingLeaseForGuild("guild-1");
    const released = await releaseMeetingLeaseByIdentifiers(
      "guild-1",
      "meeting-1",
      "instance-1",
    );

    expect(lease).toBeUndefined();
    expect(released).toBe(true);
  });
  test("recording reads exclude a TTS-only guild lease", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      sessionMode: "tts_only",
    } as Awaited<ReturnType<typeof getActiveMeetingLease>>);
    expect(await getActiveMeetingLeaseForGuild("tts-guild")).toBeUndefined();
  });

  test("requests meeting end with user id and timestamp", async () => {
    mockedRequestActiveMeetingEnd.mockResolvedValue(true);

    const requested = await requestMeetingEndViaLease(
      "guild-1",
      "meeting-1",
      "user-1",
    );

    expect(requested).toBe(true);
    expect(mockedRequestActiveMeetingEnd).toHaveBeenCalledWith(
      "guild-1",
      "meeting-1",
      "user-1",
      expect.any(String),
      MEETING_END_REASONS.WEB_UI,
    );
    const calledWithTimestamp =
      mockedRequestActiveMeetingEnd.mock.calls[0]?.[3];
    expect(Number.isNaN(Date.parse(calledWithTimestamp ?? ""))).toBe(false);
  });

  test("continues heartbeat renewal while meeting is finishing", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });
    mockedRenewActiveMeetingLease.mockResolvedValue(true);

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: true,
      finished: false,
      endTime: new Date("2026-02-14T20:00:05.000Z"),
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(1);
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledWith(
      "guild-1",
      "meeting-1",
      "instance-1",
      expect.any(Number),
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({
        endedAt: "2026-02-14T20:00:05.000Z",
      }),
    );
  });

  test("prevents overlapping heartbeat renew attempts", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });

    let resolveFirstRenew: ((value: boolean) => void) | undefined;
    const firstRenew = new Promise<boolean>((resolve) => {
      resolveFirstRenew = resolve;
    });

    mockedRenewActiveMeetingLease
      .mockReturnValueOnce(firstRenew)
      .mockResolvedValue(true);

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: false,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(20_000);
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(1);

    resolveFirstRenew?.(true);
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(2);
  });

  test("ignores remote end request while meeting is finishing", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-1",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
      endRequestedAt: "2026-02-14T20:00:05.000Z",
      endRequestedByUserId: "user-1",
    });
    mockedRenewActiveMeetingLease.mockResolvedValue(true);
    const onEndMeeting = jest.fn<() => Promise<void>>().mockResolvedValue();

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: true,
      finished: false,
      onEndMeeting,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(onEndMeeting).not.toHaveBeenCalled();
    expect(mockedRenewActiveMeetingLease).toHaveBeenCalledTimes(1);
  });

  test("does not overwrite end reason when lease changes during finishing", async () => {
    mockedGetActiveMeetingLease.mockResolvedValue({
      guildId: "guild-1",
      meetingId: "meeting-1",
      ownerInstanceId: "instance-2",
      voiceChannelId: "voice-1",
      textChannelId: "text-1",
      isAutoRecording: false,
      leaseExpiresAt: 1771099230,
      createdAt: "2026-02-14T20:00:00.000Z",
      updatedAt: "2026-02-14T20:00:00.000Z",
      expiresAt: 1771099350,
    });
    const onEndMeeting = jest.fn<() => Promise<void>>().mockResolvedValue();

    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: true,
      finished: false,
      endReason: MEETING_END_REASONS.BUTTON,
      onEndMeeting,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(onEndMeeting).not.toHaveBeenCalled();
    expect(meeting.endReason).toBe(MEETING_END_REASONS.BUTTON);
    expect(mockedRenewActiveMeetingLease).not.toHaveBeenCalled();
    expect(meeting.leaseHeartbeatTimer).toBeUndefined();
  });

  test("stops heartbeat immediately when meeting is already finished", async () => {
    const meeting = {
      guildId: "guild-1",
      meetingId: "meeting-1",
      leaseOwnerInstanceId: "instance-1",
      finishing: false,
      finished: true,
    } as unknown as MeetingData;

    startMeetingLeaseHeartbeat(meeting);

    await jest.advanceTimersByTimeAsync(10_000);

    expect(mockedGetActiveMeetingLease).not.toHaveBeenCalled();
    expect(mockedRenewActiveMeetingLease).not.toHaveBeenCalled();
    expect(meeting.leaseHeartbeatTimer).toBeUndefined();
  });
});
