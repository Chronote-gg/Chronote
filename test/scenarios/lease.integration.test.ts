/** @jest-environment node */
import { createLeaseTables } from "../repositories/meetingLeaseDynamo.fixture";
import { historyRow } from "../repositories/meetingLeaseRepository.contract";
import {
  describeLocalDynamo,
  localDynamoClient,
} from "../repositories/workerRegistryDynamo.fixture";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import type { MeetingLeaseRepository } from "../../src/repositories/meetingLeaseRepository";

const MS_PER_SECOND = 1000;
const START_SECONDS = 1_000_000;
const GUILD = "synthetic-guild";
const MAX_DURATION_MS = 60 * 60_000;

function simulatedWorkers(repository: MeetingLeaseRepository) {
  let nowMs = START_SECONDS * MS_PER_SECOND;
  function worker(instanceId: string) {
    let pending: (() => Promise<void>) | undefined;
    const service = createMeetingLeaseService({
      repository,
      instanceId: () => instanceId,
      nowMs: () => nowMs,
      schedule(run) {
        pending = run;
        return () => {
          pending = undefined;
        };
      },
    });
    const hooks = {
      maxDurationMs: MAX_DURATION_MS,
      snapshot: () => ({ status: "in_progress" as const }),
      onEndRequested: jest.fn(),
      onLost: jest.fn(),
      onCapReached: jest.fn(),
    };
    return {
      service,
      hooks,
      start(meetingId: string) {
        return service.acquireSessionLease({
          guildId: GUILD,
          meetingId,
          voiceChannelId: "synthetic-voice",
          textChannelId: "synthetic-text",
          isAutoRecording: false,
          reservedAt: nowMs,
          sessionMode: "meeting",
          history: {
            ...historyRow(meetingId),
            channelId_timestamp: `synthetic-voice#${meetingId}`,
          },
        });
      },
      async tick() {
        const run = pending;
        if (!run) throw new Error(`${instanceId} has no renewal scheduled`);
        pending = undefined;
        await run();
      },
      renewing: () => pending !== undefined,
    };
  }
  return {
    worker,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

const STALL_MS = (LIFECYCLE.leaseSeconds + 1) * MS_PER_SECOND;

describeLocalDynamo("lease scenarios against local Dynamo", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test("scenario 8: two workers receive the same start, exactly one meeting", async () => {
    const tables = await createLeaseTables(client);
    try {
      const { worker } = simulatedWorkers(tables.repository);
      const a = worker("synthetic-worker-a");
      const b = worker("synthetic-worker-b");
      const results = await Promise.all([
        a.start("synthetic-meeting-a"),
        b.start("synthetic-meeting-b"),
      ]);
      const admitted = results.filter((result) => result.kind === "admitted");
      expect(admitted).toHaveLength(1);
      expect(results).toContainEqual({
        kind: "blocked",
        reason: "active_session",
      });
      const winner = admitted[0];
      if (winner.kind !== "admitted") throw new Error("Expected admission");
      const lease = await tables.repository.read(GUILD);
      expect(lease).toMatchObject({
        meetingId: winner.reservation.meetingId,
        ownerInstanceId: winner.reservation.ownerInstanceId,
      });
      const rows = await Promise.all(
        ["synthetic-meeting-a", "synthetic-meeting-b"].map((meetingId) =>
          tables.readHistory({
            guildId: GUILD,
            channelId_timestamp: `synthetic-voice#${meetingId}`,
          }),
        ),
      );
      expect(rows.filter(Boolean)).toHaveLength(1);
    } finally {
      await tables.dispose();
    }
  });

  test("scenario 11: a stalled worker retakes a lease nobody took", async () => {
    const tables = await createLeaseTables(client);
    try {
      const clock = simulatedWorkers(tables.repository);
      const a = clock.worker("synthetic-worker-a");
      const started = await a.start("synthetic-meeting-a");
      if (started.kind !== "admitted") throw new Error("Expected admission");
      a.service.startLeaseRenewal(started.reservation, a.hooks);
      clock.advance(STALL_MS);
      await a.tick();
      expect(a.hooks.onLost).not.toHaveBeenCalled();
      expect(a.renewing()).toBe(true);
      expect(await tables.repository.read(GUILD)).toMatchObject({
        meetingId: "synthetic-meeting-a",
        status: "in_progress",
      });
      await expect(
        a.service.confirmSessionLease(started.reservation),
      ).resolves.toBe("held");
    } finally {
      await tables.dispose();
    }
  });

  test("scenario 11: a worker stalled past the adoption grace loses a lease nobody took", async () => {
    const tables = await createLeaseTables(client);
    try {
      const clock = simulatedWorkers(tables.repository);
      const a = clock.worker("synthetic-worker-a");
      const started = await a.start("synthetic-meeting-a");
      if (started.kind !== "admitted") throw new Error("Expected admission");
      a.service.startLeaseRenewal(started.reservation, a.hooks);
      const lapsed = await tables.repository.read(GUILD);
      clock.advance(
        (LIFECYCLE.leaseSeconds + LIFECYCLE.abandonedGraceSeconds) *
          MS_PER_SECOND,
      );
      await a.tick();
      expect(a.hooks.onLost).toHaveBeenCalledTimes(1);
      expect(a.renewing()).toBe(false);
      expect(await tables.repository.read(GUILD)).toEqual(lapsed);
    } finally {
      await tables.dispose();
    }
  });

  test("scenario 11: a stalled worker yields to a meeting started in its place", async () => {
    const tables = await createLeaseTables(client);
    try {
      const clock = simulatedWorkers(tables.repository);
      const a = clock.worker("synthetic-worker-a");
      const b = clock.worker("synthetic-worker-b");
      const first = await a.start("synthetic-meeting-a");
      if (first.kind !== "admitted") throw new Error("Expected admission");
      a.service.startLeaseRenewal(first.reservation, a.hooks);
      clock.advance(STALL_MS);
      const second = await b.start("synthetic-meeting-b");
      if (second.kind !== "admitted") throw new Error("Expected admission");
      b.service.startLeaseRenewal(second.reservation, b.hooks);
      await a.tick();
      expect(a.hooks.onLost).toHaveBeenCalledTimes(1);
      expect(a.renewing()).toBe(false);
      await a.service.releaseSessionLease(first.reservation);
      clock.advance(LIFECYCLE.leaseHeartbeatMs);
      await b.tick();
      expect(b.hooks.onLost).not.toHaveBeenCalled();
      expect(await tables.repository.read(GUILD)).toMatchObject({
        meetingId: "synthetic-meeting-b",
        ownerInstanceId: "synthetic-worker-b",
        status: "in_progress",
      });
    } finally {
      await tables.dispose();
    }
  });
});
