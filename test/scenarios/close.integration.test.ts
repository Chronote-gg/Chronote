/** @jest-environment node */
import type { VoiceConnection } from "@discordjs/voice";
import { createLeaseTables } from "../repositories/meetingLeaseDynamo.fixture";
import { historyRow } from "../repositories/meetingLeaseRepository.contract";
import {
  describeLocalDynamo,
  localDynamoClient,
} from "../repositories/workerRegistryDynamo.fixture";
import { createDynamoMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  createMeetingClose,
  type MeetingCloseDeps,
} from "../../src/services/meetingClose";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/meetingHistoryTransition";

const MS_PER_SECOND = 1000;
const START_SECONDS = 1_000_000;
const GUILD = "synthetic-guild";
const MAX_DURATION_MS = 60 * 60_000;
const STALL_MS = (LIFECYCLE.leaseSeconds + 1) * MS_PER_SECOND;

const historyKey = (meetingId: string) => ({
  guildId: GUILD,
  channelId_timestamp: `synthetic-voice#${meetingId}`,
});

type Tables = Awaited<ReturnType<typeof createLeaseTables>>;

function simulatedWorkers(
  tables: Tables,
  client: ReturnType<typeof localDynamoClient>,
) {
  let nowMs = START_SECONDS * MS_PER_SECOND;
  const finish = createDynamoMeetingFinishRepository(client, tables.tables);

  function worker(instanceId: string) {
    let pending: (() => Promise<void>) | undefined;
    const lease = createMeetingLeaseService({
      repository: tables.repository,
      instanceId: () => instanceId,
      nowMs: () => nowMs,
      schedule(run) {
        pending = run;
        return () => {
          pending = undefined;
        };
      },
    });
    const voice = { leave: jest.fn(), drop: jest.fn() };
    const flush = jest.fn(async () => true);
    const close = createMeetingClose({
      lease,
      finish,
      stopCapture(meeting, disposition) {
        const startedAt = meeting.startTime.toISOString();
        const endedAt = new Date(nowMs).toISOString();
        meeting.recordingCaptureState =
          disposition === "complete"
            ? { kind: "complete", startedAt, endedAt }
            : { kind: "interrupted", startedAt, endedAt, detectedAt: endedAt };
      },
      leaveVoice: voice.leave,
      dropVoiceLocally: voice.drop,
      restoreNickname: async () => true,
      flushCapture: flush,
      prepareLocalFinish: async () => undefined,
      dropMeeting: () => undefined,
      liveMeetings: () => [],
      releaseCaptureProtection: () => undefined,
      isEligible: () => true,
      isShuttingDown: () => false,
      instanceId: () => instanceId,
      localFinishStarter: () => async () => true,
      // These closes run no encoder.
      endEncoder: async () => undefined,
      nowMs: () => nowMs,
      sleep: () => new Promise<void>(() => undefined),
    } satisfies MeetingCloseDeps);

    async function start(meetingId: string) {
      const admission = await lease.acquireSessionLease({
        guildId: GUILD,
        meetingId,
        voiceChannelId: "synthetic-voice",
        textChannelId: "synthetic-text",
        isAutoRecording: false,
        reservedAt: nowMs,
        sessionMode: "meeting",
        history: {
          ...historyRow(meetingId),
          channelId_timestamp: historyKey(meetingId).channelId_timestamp,
        },
      });
      if (admission.kind !== "admitted")
        throw new Error(`Expected admission, got ${admission.reason}`);
      const reservation: SessionReservation = admission.reservation;
      const meeting = {
        meetingId,
        guildId: GUILD,
        sessionMode: "meeting",
        reservation,
        connection: { synthetic: meetingId } as unknown as VoiceConnection,
        startTime: new Date(nowMs),
        recordingCaptureState: {
          kind: "capturing",
          startedAt: new Date(nowMs).toISOString(),
        },
      } as unknown as MeetingData;
      lease.startLeaseRenewal(reservation, {
        maxDurationMs: MAX_DURATION_MS,
        snapshot: () => ({ status: "in_progress" }),
        onEndRequested: () => undefined,
        onLost: () => close.captureEndHandlers.onLost({ reservation, meeting }),
        onCapReached: () =>
          close.captureEndHandlers.onCapReached({ reservation, meeting }),
      });
      return meeting;
    }

    return {
      voice,
      flush,
      close,
      start,
      async tick() {
        const run = pending;
        if (!run) throw new Error(`${instanceId} has no renewal scheduled`);
        pending = undefined;
        await run();
      },
    };
  }

  return {
    worker,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describeLocalDynamo("close scenarios against local Dynamo", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test("scenario 11: a stalled worker saves an interrupted capture without a leave, a flush or a claim, and the new capture's lease is untouched", async () => {
    const tables = await createLeaseTables(client);
    try {
      const clock = simulatedWorkers(tables, client);
      const a = clock.worker("synthetic-worker-a");
      const b = clock.worker("synthetic-worker-b");
      const first = await a.start("synthetic-meeting-a");
      clock.advance(STALL_MS);
      await b.start("synthetic-meeting-b");
      const leaseBefore = await tables.repository.read(GUILD);

      await a.tick();
      await a.close.closeMeeting(first, { endReason: "button" });

      expect(a.voice.leave).not.toHaveBeenCalled();
      expect(a.voice.drop).toHaveBeenCalledWith(first.connection);
      expect(a.flush).not.toHaveBeenCalled();
      const row = await tables.readHistory(historyKey("synthetic-meeting-a"));
      expect(row).toMatchObject({
        status: "processing",
        endReason: "unknown",
        capture: { kind: "interrupted" },
        duration: STALL_MS / MS_PER_SECOND,
      });
      expect(row?.finish).toBeUndefined();
      expect(await tables.repository.read(GUILD)).toEqual(leaseBefore);
      expect(leaseBefore).toMatchObject({
        meetingId: "synthetic-meeting-b",
        ownerInstanceId: "synthetic-worker-b",
      });
      expect(
        await tables.readHistory(historyKey("synthetic-meeting-b")),
      ).toMatchObject({ status: "starting" });
    } finally {
      await tables.dispose();
    }
  });

  test("after a normal close the same server can start a new meeting while the first row is still processing", async () => {
    const tables = await createLeaseTables(client);
    try {
      const clock = simulatedWorkers(tables, client);
      const a = clock.worker("synthetic-worker-a");
      const first = await a.start("synthetic-meeting-a");
      clock.advance(LIFECYCLE.leaseHeartbeatMs);

      await a.close.closeMeeting(first, {
        endReason: "button",
        endTriggeredByUserId: "synthetic-user",
      });

      expect(a.voice.leave).toHaveBeenCalledWith(first.connection);
      expect(await tables.repository.read(GUILD)).toBeUndefined();
      const second = await a.start("synthetic-meeting-b");
      expect(second.reservation?.meetingId).toBe("synthetic-meeting-b");
      const row = await tables.readHistory(historyKey("synthetic-meeting-a"));
      expect(row).toMatchObject({
        status: "processing",
        endReason: "button",
        endTriggeredByUserId: "synthetic-user",
        capture: { kind: "complete" },
        finish: {
          owner: expect.stringMatching(/^synthetic-worker-a:/),
          attempts: 0,
          phase: "process",
        },
      });
    } finally {
      await tables.dispose();
    }
  });
});
