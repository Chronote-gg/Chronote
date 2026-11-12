import { randomUUID } from "node:crypto";
import type { MeetingLeaseRepository } from "../../src/repositories/meetingLeaseRepository";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { HistoryKey } from "../../src/types/meetingHistoryTransition";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";

export type SuppressionSeed = {
  guildId: string;
  channelId: string;
  version: number;
  suppressed: boolean;
};
export function suppressionRecord(row: SuppressionSeed) {
  return {
    pk: `SUPPRESS#${row.guildId}`,
    sk: `CHANNEL#${row.channelId}`,
    recordType: "suppression" as const,
    protocolVersion: 1 as const,
    guildId: row.guildId,
    channelId: row.channelId,
    meetingId: "synthetic-suppressing-meeting",
    createdAt: 1,
    version: row.version,
    suppressed: row.suppressed,
    reason: "explicit_end" as const,
  };
}
export interface MeetingLeaseHarness {
  repository: MeetingLeaseRepository;
  seedLease(lease: ActiveMeetingLease): Promise<void>;
  seedHistory(row: MeetingHistory): Promise<void>;
  seedSuppression(row: SuppressionSeed): Promise<void>;
  readHistory(key: HistoryKey): Promise<MeetingHistory | undefined>;
  dispose?(): Promise<void>;
}

const NOW = 1_000_000;
const CLOCK_AHEAD_SECONDS = 15;
export const GUILD = "synthetic-guild";
const CHANNEL = "synthetic-voice";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

export function leaseRecord(
  overrides: Partial<ActiveMeetingLease> = {},
): ActiveMeetingLease {
  const leaseExpiresAt =
    overrides.leaseExpiresAt ?? NOW + LIFECYCLE.leaseSeconds;
  return {
    guildId: GUILD,
    meetingId: "synthetic-meeting-a",
    ownerInstanceId: "synthetic-owner-a",
    executionVersion: 1,
    sessionMode: "meeting",
    voiceOperationAttemptId: "synthetic-attempt-a",
    voiceChannelId: CHANNEL,
    textChannelId: "synthetic-text",
    isAutoRecording: false,
    status: "starting",
    leaseExpiresAt,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    expiresAt: leaseExpiresAt + LIFECYCLE.leaseTtlGraceSeconds,
    ...overrides,
  };
}

export function historyRow(meetingId = "synthetic-meeting-a"): MeetingHistory {
  return {
    guildId: GUILD,
    channelId_timestamp: `${CHANNEL}#${TIMESTAMP}`,
    meetingId,
    channelId: CHANNEL,
    timestamp: TIMESTAMP,
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    status: "starting",
    ownerInstanceId: "synthetic-owner-a",
    executionVersion: 1,
    lifecycleVersion: 2,
  };
}

function ownershipOf(lease: ActiveMeetingLease) {
  return {
    guildId: lease.guildId,
    meetingId: lease.meetingId,
    ownerInstanceId: lease.ownerInstanceId,
    executionVersion: 1,
    voiceOperationAttemptId: lease.voiceOperationAttemptId ?? "",
    sessionMode: "meeting" as const,
  };
}

const otherMeeting = () =>
  leaseRecord({
    meetingId: "synthetic-meeting-b",
    ownerInstanceId: "synthetic-owner-b",
    voiceOperationAttemptId: "synthetic-attempt-b",
  });

/** DynamoDB rejects a reused ClientRequestToken with different parameters, so each start gets its own attempt. */
const startLease = (overrides: Partial<ActiveMeetingLease> = {}) =>
  leaseRecord({ voiceOperationAttemptId: randomUUID(), ...overrides });

export function meetingLeaseRepositoryContract(
  make: () => Promise<MeetingLeaseHarness>,
) {
  let h: MeetingLeaseHarness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.dispose?.();
  });
  const history = historyRow();
  const key = {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };

  describe("startSession", () => {
    it("start wins over an absent lease and writes the history row", async () => {
      const lease = startLease();
      await expect(
        h.repository.startSession({ lease, history, now: NOW }),
      ).resolves.toBe("admitted");
      await expect(h.repository.read(GUILD)).resolves.toEqual(lease);
      await expect(h.readHistory(key)).resolves.toEqual(history);
    });

    it("start loses to a live lease", async () => {
      await h.seedLease(otherMeeting());
      await expect(
        h.repository.startSession({ lease: startLease(), history, now: NOW }),
      ).resolves.toBe("active_session");
      await expect(h.repository.read(GUILD)).resolves.toEqual(otherMeeting());
      await expect(h.readHistory(key)).resolves.toBeUndefined();
    });

    it("a writer fifteen seconds ahead does not take a live lease", async () => {
      await h.seedLease(otherMeeting());
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          now: NOW + CLOCK_AHEAD_SECONDS,
        }),
      ).resolves.toBe("active_session");
    });

    it("start wins over an expired lease", async () => {
      await h.seedLease({ ...otherMeeting(), leaseExpiresAt: NOW - 1 });
      const lease = startLease();
      await expect(
        h.repository.startSession({ lease, history, now: NOW }),
      ).resolves.toBe("admitted");
      await expect(h.repository.read(GUILD)).resolves.toEqual(lease);
    });

    it("an existing history row refuses as an active session", async () => {
      await h.seedHistory(historyRow("synthetic-meeting-b"));
      await expect(
        h.repository.startSession({ lease: startLease(), history, now: NOW }),
      ).resolves.toBe("active_session");
      await expect(h.repository.read(GUILD)).resolves.toBeUndefined();
    });

    it("a TTS session writes only the lease", async () => {
      const lease = startLease({ sessionMode: "tts_only" });
      await expect(
        h.repository.startSession({ lease, now: NOW }),
      ).resolves.toBe("admitted");
      await expect(h.repository.read(GUILD)).resolves.toEqual(lease);
    });

    it("suppressed channel refuses", async () => {
      await h.seedSuppression({
        guildId: GUILD,
        channelId: CHANNEL,
        version: 2,
        suppressed: true,
      });
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          suppression: { channelId: CHANNEL, expectedVersion: 2 },
          now: NOW,
        }),
      ).resolves.toBe("suppressed");
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          suppression: { channelId: CHANNEL },
          now: NOW,
        }),
      ).resolves.toBe("suppressed");
      await expect(h.repository.read(GUILD)).resolves.toBeUndefined();
      await expect(h.readHistory(key)).resolves.toBeUndefined();
    });

    it("a lifted suppression admits at its observed version only", async () => {
      await h.seedSuppression({
        guildId: GUILD,
        channelId: CHANNEL,
        version: 3,
        suppressed: false,
      });
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          suppression: { channelId: CHANNEL, expectedVersion: 2 },
          now: NOW,
        }),
      ).resolves.toBe("suppressed");
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          suppression: { channelId: CHANNEL, expectedVersion: 3 },
          now: NOW,
        }),
      ).resolves.toBe("admitted");
    });

    it("an absent suppression row admits without a version", async () => {
      await expect(
        h.repository.startSession({
          lease: startLease(),
          history,
          suppression: { channelId: CHANNEL },
          now: NOW,
        }),
      ).resolves.toBe("admitted");
    });
  });

  describe("readSuppression", () => {
    it("reads the version and flag, or nothing", async () => {
      await expect(
        h.repository.readSuppression(GUILD, CHANNEL),
      ).resolves.toBeUndefined();
      await h.seedSuppression({
        guildId: GUILD,
        channelId: CHANNEL,
        version: 4,
        suppressed: true,
      });
      await expect(
        h.repository.readSuppression(GUILD, CHANNEL),
      ).resolves.toEqual({ version: 4, suppressed: true });
    });
  });

  describe("renew", () => {
    const next = {
      leaseExpiresAt: NOW + 40,
      expiresAt: NOW + 160,
      updatedAt: "2026-01-01T00:00:10.000Z",
      snapshot: {
        status: "in_progress" as const,
        endReason: "button" as const,
        endTriggeredByUserId: "synthetic-user",
      },
    };

    it("extends a live lease it owns and writes the snapshot", async () => {
      await h.seedLease(leaseRecord());
      await expect(
        h.repository.renew(ownershipOf(leaseRecord()), next, NOW),
      ).resolves.toBe(true);
      await expect(h.repository.read(GUILD)).resolves.toEqual(
        leaseRecord({
          leaseExpiresAt: next.leaseExpiresAt,
          expiresAt: next.expiresAt,
          updatedAt: next.updatedAt,
          ...next.snapshot,
        }),
      );
    });

    it("fails its condition once the lease expired or names another meeting", async () => {
      await h.seedLease(leaseRecord({ leaseExpiresAt: NOW - 1 }));
      await expect(
        h.repository.renew(ownershipOf(leaseRecord()), next, NOW),
      ).resolves.toBe(false);
      await h.seedLease(otherMeeting());
      await expect(
        h.repository.renew(ownershipOf(leaseRecord()), next, NOW),
      ).resolves.toBe(false);
      await expect(h.repository.read(GUILD)).resolves.toEqual(otherMeeting());
    });

    it("fails its condition when the lease is absent", async () => {
      await expect(
        h.repository.renew(ownershipOf(leaseRecord()), next, NOW),
      ).resolves.toBe(false);
      await expect(h.repository.read(GUILD)).resolves.toBeUndefined();
    });
  });

  describe("retake", () => {
    it("retake refuses another meeting", async () => {
      await h.seedLease(otherMeeting());
      await expect(h.repository.retake(leaseRecord(), NOW)).resolves.toBe(
        false,
      );
      await expect(h.repository.read(GUILD)).resolves.toEqual(otherMeeting());
    });

    it("takes an absent or expired lease, or its own", async () => {
      await expect(h.repository.retake(leaseRecord(), NOW)).resolves.toBe(true);
      const own = leaseRecord({ leaseExpiresAt: NOW + 50 });
      await expect(h.repository.retake(own, NOW)).resolves.toBe(true);
      await h.seedLease({ ...otherMeeting(), leaseExpiresAt: NOW - 1 });
      await expect(h.repository.retake(own, NOW)).resolves.toBe(true);
      await expect(h.repository.read(GUILD)).resolves.toEqual(own);
    });

    it("retake refuses when a stop request arrived after the read", async () => {
      const stop = {
        endRequestedAt: "2026-01-01T00:01:00.000Z",
        endRequestedByUserId: "synthetic-user",
      };
      await h.seedLease(leaseRecord({ leaseExpiresAt: NOW - 1, ...stop }));
      const retaken = leaseRecord({ leaseExpiresAt: NOW + 30 });
      await expect(h.repository.retake(retaken, NOW)).resolves.toBe(false);
      await expect(
        h.repository.retake(
          { ...retaken, endRequestedAt: "2026-01-01T00:00:30.000Z" },
          NOW,
        ),
      ).resolves.toBe(false);
      await expect(h.repository.read(GUILD)).resolves.toMatchObject(stop);
      await expect(
        h.repository.retake({ ...retaken, ...stop }, NOW),
      ).resolves.toBe(true);
      await expect(h.repository.read(GUILD)).resolves.toEqual({
        ...retaken,
        ...stop,
      });
    });

    it("another meeting's stop request does not block taking its expired lease", async () => {
      await h.seedLease({
        ...otherMeeting(),
        leaseExpiresAt: NOW - 1,
        endRequestedAt: "2026-01-01T00:01:00.000Z",
      });
      await expect(h.repository.retake(leaseRecord(), NOW)).resolves.toBe(true);
      await expect(h.repository.read(GUILD)).resolves.toEqual(leaseRecord());
    });
  });

  describe("release", () => {
    it("deletes only the attempt it names", async () => {
      await h.seedLease(leaseRecord());
      await expect(
        h.repository.release({
          ...ownershipOf(leaseRecord()),
          voiceOperationAttemptId: "synthetic-attempt-other",
        }),
      ).resolves.toBe(false);
      await expect(
        h.repository.release(ownershipOf(otherMeeting())),
      ).resolves.toBe(false);
      await expect(
        h.repository.release(ownershipOf(leaseRecord())),
      ).resolves.toBe(true);
      await expect(h.repository.read(GUILD)).resolves.toBeUndefined();
      await expect(
        h.repository.release(ownershipOf(leaseRecord())),
      ).resolves.toBe(false);
    });
  });
}
