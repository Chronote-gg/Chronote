import type {
  FinisherRow,
  MeetingFinishRepository,
} from "../../src/repositories/meetingFinishRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import type {
  HistoryKey,
  SessionReservation,
} from "../../src/types/meetingHistoryTransition";

export interface MeetingFinishHarness {
  repository: MeetingFinishRepository;
  seedHistory(row: MeetingHistory): Promise<void>;
  seedLease(lease: ActiveMeetingLease): Promise<void>;
  readHistory(key: HistoryKey): Promise<MeetingHistory | undefined>;
  dispose?(): Promise<void>;
}

const NOW = 2_000_000_000;
const GUILD = "synthetic-guild";
const WORKER_A = "synthetic-worker-a";
const WORKER_B = "synthetic-worker-b";
const CLAIM = LIFECYCLE.finishClaimSeconds;
const RENEW_SECONDS = LIFECYCLE.finishClaimRenewMs / 1000;
const FIFTEEN_SECONDS = 15;

export function historyRow(
  id: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory {
  return {
    guildId: GUILD,
    channelId_timestamp: `synthetic-channel#2026-01-01T00:00:00.000Z#${id}`,
    meetingId: `synthetic-meeting-${id}`,
    channelId: "synthetic-channel",
    timestamp: "2026-01-01T00:00:00.000Z",
    participants: [],
    duration: 0,
    transcribeMeeting: true,
    generateNotes: true,
    lifecycleVersion: 2,
    status: "in_progress",
    ownerInstanceId: WORKER_A,
    executionVersion: 1,
    ...overrides,
  };
}

function keyOf(row: MeetingHistory): HistoryKey {
  return { guildId: row.guildId, channelId_timestamp: row.channelId_timestamp };
}

function finisherRow(row: MeetingHistory): FinisherRow {
  return {
    guildId: row.guildId,
    channelId_timestamp: row.channelId_timestamp,
    meetingId: row.meetingId,
    status: row.status,
    timestamp: row.timestamp,
    updatedAt: row.updatedAt,
    lifecycleVersion: row.lifecycleVersion,
    finish: row.finish,
    ownerInstanceId: row.ownerInstanceId,
  };
}

function reservationFor(row: MeetingHistory): SessionReservation {
  return {
    guildId: row.guildId,
    meetingId: row.meetingId,
    ownerInstanceId: WORKER_A,
    executionVersion: 1,
    voiceOperationAttemptId: "synthetic-attempt",
    reservedAt: NOW,
    sessionMode: "meeting",
    historyKey: keyOf(row),
  };
}

function leaseFor(
  meetingId: string,
  leaseExpiresAt: number,
): ActiveMeetingLease {
  return {
    guildId: GUILD,
    meetingId,
    ownerInstanceId: WORKER_A,
    voiceChannelId: "synthetic-voice",
    textChannelId: "synthetic-text",
    isAutoRecording: false,
    leaseExpiresAt,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: leaseExpiresAt + 1,
    sessionMode: "meeting",
    voiceOperationAttemptId: "synthetic-attempt",
    executionVersion: 1,
  };
}

const capturePatch = {
  capture: {
    kind: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:10:00.000Z",
  },
  endReason: "button",
  endTriggeredByUserId: "synthetic-user",
  duration: 600,
} satisfies Parameters<MeetingFinishRepository["recordCaptureEnd"]>[0]["patch"];

const derivedEnd = {
  capture: {
    kind: "interrupted",
    startedAt: "2026-01-01T00:00:00.000Z",
    detectedAt: "2026-01-01T00:20:00.000Z",
    endedAt: "2026-01-01T00:05:00.000Z",
  },
  endReason: "unknown",
  duration: 300,
} satisfies Parameters<MeetingFinishRepository["adopt"]>[2];

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

export function meetingFinishContract(
  make: () => Promise<MeetingFinishHarness>,
) {
  let h: MeetingFinishHarness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.dispose?.();
  });

  async function seed(id: string, overrides: Partial<MeetingHistory> = {}) {
    const row = historyRow(id, overrides);
    await h.seedHistory(row);
    return row;
  }

  describe("recordCaptureEnd", () => {
    it("moves a live row to processing with this worker's claim", async () => {
      const row = await seed("a");
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: capturePatch,
          claimOwner: WORKER_A,
          now: NOW,
        }),
      ).resolves.toBe(true);
      const saved = await h.readHistory(keyOf(row));
      expect(saved).toMatchObject({ status: "processing", ...capturePatch });
      expect(saved?.updatedAt).toBe(new Date(NOW * 1000).toISOString());
      expect(saved?.finish).toEqual({
        owner: WORKER_A,
        expiresAt: NOW + CLAIM,
        attempts: 0,
        startedAt: NOW,
        phase: "process",
      });
    });

    it("recordCaptureEnd sets the completion policy once, and a malformed one is refused", async () => {
      const row = await seed("a", { status: "in_progress" });
      const completionPolicy = {
        policy: {
          enabled: true,
          maximumSeconds: 90,
          maximumWords: 50,
          maximumChatMessages: 1,
          dismissedMinimumMilliseconds: 600_000,
          dismissedMinimumChatMessages: 2,
        },
        isAutoRecording: true,
        elapsedMilliseconds: 1_000,
        chatMessageCount: 0,
        dismissed: true,
        decision: "cancel" as const,
      };
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: {
            ...capturePatch,
            completionPolicy: { ...completionPolicy, decision: "nope" },
          } as never,
          now: NOW,
        }),
      ).rejects.toThrow();
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: {
            ...capturePatch,
            completionPolicy,
            cancellationReason: "Stopped by synthetic user",
          },
          now: NOW,
        }),
      ).resolves.toBe(true);
      expect(await h.readHistory(keyOf(row))).toMatchObject({
        status: "processing",
        completionPolicy,
        cancellationReason: "Stopped by synthetic user",
      });
      // The row is no longer live, so a second capture end cannot rewrite the decision.
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: {
            ...capturePatch,
            completionPolicy: { ...completionPolicy, decision: "proceed" },
          },
          now: NOW,
        }),
      ).resolves.toBe(false);
      expect(
        (await h.readHistory(keyOf(row)))?.completionPolicy?.decision,
      ).toBe("cancel");
    });

    it("recordCaptureEnd without a claim owner writes no finish map", async () => {
      const row = await seed("a", { status: "starting" });
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: capturePatch,
          now: NOW,
        }),
      ).resolves.toBe(true);
      const saved = await h.readHistory(keyOf(row));
      expect(saved?.status).toBe("processing");
      expect(saved).not.toHaveProperty("finish");
    });

    it("recordCaptureEnd refuses a row that is already processing", async () => {
      const row = await seed("a", { status: "processing" });
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: capturePatch,
          claimOwner: WORKER_A,
          now: NOW,
        }),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("recordCaptureEnd retried after its own committed write returns true", async () => {
      const row = await seed("a");
      const input = {
        reservation: reservationFor(row),
        patch: capturePatch,
        claimOwner: WORKER_A,
        now: NOW,
      };
      await expect(h.repository.recordCaptureEnd(input)).resolves.toBe(true);
      const saved = await h.readHistory(keyOf(row));
      await expect(
        h.repository.recordCaptureEnd({ ...input, now: NOW + 5 }),
      ).resolves.toBe(true);
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(saved);
    });

    it("returns false when another owner's claim is on the row", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: {
          owner: WORKER_B,
          expiresAt: NOW + CLAIM,
          attempts: 0,
          startedAt: NOW,
          phase: "process",
        },
      });
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: capturePatch,
          claimOwner: WORKER_A,
          now: NOW,
        }),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("refuses a row owned by another worker", async () => {
      const row = await seed("a", { ownerInstanceId: WORKER_B });
      await expect(
        h.repository.recordCaptureEnd({
          reservation: reservationFor(row),
          patch: capturePatch,
          now: NOW,
        }),
      ).resolves.toBe(false);
    });
  });

  describe("claim", () => {
    it("claims an unclaimed marked row and returns the saved row", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: { attempts: 2, phase: "deliver", deliverSince: NOW - 600 },
      });
      const claim = await h.repository.claim(finisherRow(row), WORKER_B, NOW);
      expect(claim).toMatchObject({
        key: keyOf(row),
        meetingId: row.meetingId,
        owner: WORKER_B,
      });
      expect(claim?.history.finish).toEqual({
        owner: WORKER_B,
        expiresAt: NOW + CLAIM,
        attempts: 2,
        startedAt: NOW,
        phase: "deliver",
        deliverSince: NOW - 600,
      });
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(claim?.history);
    });

    it("claim refuses a live claim", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: {
          owner: WORKER_A,
          expiresAt: NOW + CLAIM,
          attempts: 0,
          startedAt: NOW,
          phase: "process",
        },
      });
      await expect(
        h.repository.claim(finisherRow(row), WORKER_B, NOW + CLAIM),
      ).resolves.toBeUndefined();
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("claim takes an expired claim", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: {
          owner: WORKER_A,
          expiresAt: NOW,
          attempts: 1,
          startedAt: NOW - CLAIM,
          phase: "process",
        },
      });
      const claim = await h.repository.claim(
        finisherRow(row),
        WORKER_B,
        NOW + 1,
      );
      expect(claim?.history.finish).toEqual({
        owner: WORKER_B,
        expiresAt: NOW + 1 + CLAIM,
        attempts: 1,
        startedAt: NOW + 1,
        phase: "process",
      });
    });

    it("a writer fifteen seconds ahead does not take a live claim", async () => {
      const row = await seed("a", { status: "processing" });
      const claim = await h.repository.claim(finisherRow(row), WORKER_A, NOW);
      if (!claim) throw new Error("expected the first claim to succeed");
      const renewedAt = NOW + RENEW_SECONDS;
      await expect(h.repository.renew(claim, renewedAt)).resolves.toBe(true);
      const current = await h.readHistory(keyOf(row));
      if (!current) throw new Error("expected the row");
      await expect(
        h.repository.claim(
          finisherRow(current),
          WORKER_B,
          renewedAt + FIFTEEN_SECONDS,
        ),
      ).resolves.toBeUndefined();
      expect((await h.readHistory(keyOf(row)))?.finish?.owner).toBe(WORKER_A);
    });

    it("claim respects nextAttemptAt", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: { attempts: 1, nextAttemptAt: NOW + 60, phase: "process" },
      });
      await expect(
        h.repository.claim(finisherRow(row), WORKER_B, NOW + 59),
      ).resolves.toBeUndefined();
      const claim = await h.repository.claim(
        finisherRow(row),
        WORKER_B,
        NOW + 60,
      );
      expect(claim?.history.finish).toEqual({
        owner: WORKER_B,
        expiresAt: NOW + 60 + CLAIM,
        attempts: 1,
        startedAt: NOW + 60,
        phase: "process",
      });
    });

    it("refuses an unmarked row unless the operator asks", async () => {
      const row = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      await expect(
        h.repository.claim(finisherRow(row), WORKER_B, NOW),
      ).resolves.toBeUndefined();
      const claim = await h.repository.claim(finisherRow(row), WORKER_B, NOW, {
        operator: true,
      });
      expect(claim?.history.finish?.owner).toBe(WORKER_B);
    });

    it("operator claim refuses a marked row", async () => {
      const row = await seed("a", { status: "processing" });
      await expect(
        h.repository.claim(finisherRow(row), WORKER_B, NOW, { operator: true }),
      ).resolves.toBeUndefined();
    });

    it("a stale claim cannot take a meeting that was finished meanwhile", async () => {
      const row = await seed("a", { status: "processing" });
      const stale = finisherRow(row);
      const claim = await h.repository.claim(stale, WORKER_B, NOW);
      if (!claim) throw new Error("expected the first claim to succeed");
      await h.repository.save(claim, { status: "complete" }, NOW + 1);
      await h.repository.releaseDone(claim);
      const finished = await h.readHistory(keyOf(row));
      await expect(
        h.repository.claim(stale, WORKER_A, NOW + 2),
      ).resolves.toBeUndefined();
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(finished);
      expect(finished?.status).toBe("complete");
      expect(finished).not.toHaveProperty("finish");
    });

    it("a stale claim cannot write back an older attempt count", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: { attempts: 0, phase: "process" },
      });
      const stale = finisherRow(row);
      const claim = await h.repository.claim(stale, WORKER_B, NOW);
      if (!claim) throw new Error("expected the first claim to succeed");
      await h.repository.releaseForRetry(claim, {
        attempts: 1,
        nextAttemptAt: NOW + 60,
        phase: "process",
      });
      await expect(
        h.repository.claim(stale, WORKER_A, NOW + 61),
      ).resolves.toBeUndefined();
      expect((await h.readHistory(keyOf(row)))?.finish).toEqual({
        attempts: 1,
        nextAttemptAt: NOW + 60,
        phase: "process",
      });
    });

    it("refuses a row whose meeting id differs", async () => {
      const row = await seed("a", { status: "processing" });
      await expect(
        h.repository.claim(
          { ...finisherRow(row), meetingId: "synthetic-meeting-other" },
          WORKER_B,
          NOW,
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe("adopt", () => {
    it("adopt refuses while the lease names the meeting", async () => {
      const row = await seed("a");
      await h.seedLease(leaseFor(row.meetingId, NOW));
      await expect(
        h.repository.adopt(finisherRow(row), WORKER_B, derivedEnd, NOW),
      ).resolves.toBeUndefined();
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it.each([
      ["no lease", undefined],
      ["a lease for another meeting", "synthetic-meeting-next"],
      ["an expired lease", "expired"],
    ])("adopts an abandoned live row with %s", async (_label, lease) => {
      const row = await seed("a", { status: "starting" });
      if (lease === "expired")
        await h.seedLease(leaseFor(row.meetingId, NOW - 1));
      else if (lease) await h.seedLease(leaseFor(lease, NOW + CLAIM));
      const claim = await h.repository.adopt(
        finisherRow(row),
        WORKER_B,
        derivedEnd,
        NOW,
      );
      expect(claim).toMatchObject({ key: keyOf(row), owner: WORKER_B });
      expect(claim?.history).toMatchObject({
        status: "processing",
        ...derivedEnd,
        finish: {
          owner: WORKER_B,
          expiresAt: NOW + CLAIM,
          attempts: 0,
          startedAt: NOW,
          phase: "process",
        },
      });
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(claim?.history);
    });

    it("refuses a row whose finish counters changed since it was read", async () => {
      const row = await seed("a", {
        finish: { attempts: 1, phase: "process" },
      });
      await expect(
        h.repository.adopt(
          { ...finisherRow(row), finish: { attempts: 0, phase: "process" } },
          WORKER_B,
          derivedEnd,
          NOW,
        ),
      ).resolves.toBeUndefined();
      await expect(
        h.repository.adopt(
          { ...finisherRow(row), finish: undefined },
          WORKER_B,
          derivedEnd,
          NOW,
        ),
      ).resolves.toBeUndefined();
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("refuses a row that already left capture", async () => {
      const row = await seed("a", { status: "processing" });
      await expect(
        h.repository.adopt(finisherRow(row), WORKER_B, derivedEnd, NOW),
      ).resolves.toBeUndefined();
    });

    it("adopts an unmarked live row only when the operator asks", async () => {
      const row = await seed("a", { lifecycleVersion: undefined });
      await expect(
        h.repository.adopt(finisherRow(row), WORKER_B, derivedEnd, NOW),
      ).resolves.toBeUndefined();
      const claim = await h.repository.adopt(
        finisherRow(row),
        WORKER_B,
        derivedEnd,
        NOW,
        { operator: true },
      );
      expect(claim?.history).toMatchObject({
        status: "processing",
        ...derivedEnd,
      });
      expect(claim?.history.lifecycleVersion).toBeUndefined();
      const marked = await seed("b");
      await expect(
        h.repository.adopt(finisherRow(marked), WORKER_B, derivedEnd, NOW, {
          operator: true,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("read", () => {
    it("returns the whole row, or undefined when there is none", async () => {
      const row = await seed("a", { notes: "synthetic notes" });
      await expect(h.repository.read(keyOf(row))).resolves.toEqual(row);
      await expect(
        h.repository.read({ guildId: GUILD, channelId_timestamp: "missing" }),
      ).resolves.toBeUndefined();
    });
  });

  describe("restoreStranded", () => {
    const strandedRow = (id: string) =>
      seed(id, {
        lifecycleVersion: undefined,
        updatedAt: "2026-01-01T00:01:00.000Z",
      });

    it("puts back everything an operator attempt changed", async () => {
      const before = await strandedRow("a");
      const claim = await h.repository.adopt(
        finisherRow(before),
        WORKER_B,
        derivedEnd,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator adoption");
      await h.repository.save(
        claim,
        { transcriptS3Key: "synthetic/transcript.json" },
        NOW,
      );
      await h.repository.releaseForRetry(claim, {
        attempts: 1,
        nextAttemptAt: NOW + 60,
        phase: "process",
      });
      await expect(h.repository.restoreStranded(claim, before)).resolves.toBe(
        true,
      );
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(before);
    });

    it("keeps a transcript key the row already had", async () => {
      const before = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
        transcriptS3Key: "synthetic/earlier.json",
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator claim");
      await expect(h.repository.restoreStranded(claim, before)).resolves.toBe(
        true,
      );
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(before);
    });

    it("puts back the finish marker the row had before", async () => {
      const before = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
        finish: { attempts: 1, phase: "process" },
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator claim");
      await h.repository.save(
        claim,
        { transcriptS3Key: "synthetic/transcript.json" },
        NOW,
      );
      await expect(h.repository.restoreStranded(claim, before)).resolves.toBe(
        true,
      );
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(before);
    });

    it("refuses while another owner holds the claim", async () => {
      const before = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator claim");
      await expect(
        h.repository.restoreStranded({ ...claim, owner: WORKER_A }, before),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(
        claim.history,
      );
    });

    it("refuses a row that reached a terminal status or carries the marker", async () => {
      const before = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator claim");
      const done = await h.repository.save(claim, { status: "complete" }, NOW);
      await expect(h.repository.restoreStranded(claim, before)).resolves.toBe(
        false,
      );
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(done);
      const marked = await seed("b", { status: "processing" });
      await expect(
        h.repository.restoreStranded(
          { ...claim, key: keyOf(marked), meetingId: marked.meetingId },
          marked,
        ),
      ).resolves.toBe(false);
    });
  });

  describe("held claim", () => {
    async function claimed(id = "a") {
      const row = await seed(id, { status: "processing" });
      const claim = await h.repository.claim(finisherRow(row), WORKER_A, NOW);
      if (!claim) throw new Error("expected the claim to succeed");
      return claim;
    }

    it("renew extends only the expiry", async () => {
      const claim = await claimed();
      await expect(h.repository.renew(claim, NOW + 30)).resolves.toBe(true);
      expect((await h.readHistory(claim.key))?.finish).toEqual({
        ...claim.history.finish,
        expiresAt: NOW + 30 + CLAIM,
      });
    });

    it("renew refuses an expired claim", async () => {
      const claim = await claimed();
      await expect(h.repository.renew(claim, NOW + CLAIM + 1)).resolves.toBe(
        false,
      );
    });

    it("save writes the patch while the claim is held", async () => {
      const claim = await claimed();
      const saved = await h.repository.save(
        claim,
        { notes: "synthetic notes", status: "complete" },
        NOW + 10,
        "processing",
      );
      expect(saved).toMatchObject({
        notes: "synthetic notes",
        status: "complete",
        finish: claim.history.finish,
      });
      await expect(h.readHistory(claim.key)).resolves.toEqual(saved);
    });

    it("save refuses after losing the claim", async () => {
      const claim = await claimed();
      const later = NOW + CLAIM + 1;
      const current = await h.readHistory(claim.key);
      if (!current) throw new Error("expected the row");
      const taken = await h.repository.claim(
        finisherRow(current),
        WORKER_B,
        later,
      );
      expect(taken?.owner).toBe(WORKER_B);
      await expect(
        h.repository.save(claim, { notes: "stale" }, later),
      ).resolves.toBeUndefined();
      expect((await h.readHistory(claim.key))?.notes).toBeUndefined();
    });

    it("save refuses an unexpected status", async () => {
      const claim = await claimed();
      await expect(
        h.repository.save(claim, { notes: "x" }, NOW + 1, "complete"),
      ).resolves.toBeUndefined();
    });

    it("save refuses when the update delivery changed since it was read", async () => {
      const claim = await claimed();
      const updateDelivery = requestMeetingUpdateDelivery({
        history: claim.history,
        mutation: { kind: "rename", meetingName: "Synthetic edit" },
        revision: "synthetic-edit",
        now: NOW,
        policy: { kind: "held", reason: "legacy_publication_unknown" },
      });
      await expect(
        h.repository.save(claim, { notes: "first" }, NOW + 1, undefined, {
          updateDelivery: undefined,
        }),
      ).resolves.toMatchObject({ notes: "first" });
      await h.repository.save(claim, { updateDelivery }, NOW + 1);
      await expect(
        h.repository.save(claim, { notes: "stale" }, NOW + 1, undefined, {
          updateDelivery: undefined,
        }),
      ).resolves.toBeUndefined();
      await expect(
        h.repository.save(claim, { notes: "fresh" }, NOW + 1, undefined, {
          updateDelivery,
        }),
      ).resolves.toMatchObject({ notes: "fresh" });
    });

    it("save never rewrites the key attributes", async () => {
      const claim = await claimed();
      const saved = await h.repository.save(
        claim,
        {
          guildId: "synthetic-other-guild",
          channelId_timestamp: "synthetic-other-key",
          notes: "synthetic notes",
        },
        NOW + 1,
      );
      expect(saved).toMatchObject({ ...claim.key, notes: "synthetic notes" });
      await expect(h.readHistory(claim.key)).resolves.toEqual(saved);
    });

    it("save removes a leftover recovery value in the same claim-conditioned write", async () => {
      const claim = await claimed();
      const recovery = {
        disposition: "pending" as const,
        attempt: 0,
        executionVersion: 1,
        stage: "verification" as const,
        retry: { maxAttempts: 3, nextAttemptAt: null },
      };
      await h.repository.save(claim, { recovery }, NOW + 1);
      await expect(
        h.repository.save(claim, {}, NOW + CLAIM + 1, undefined, undefined, [
          "recovery",
        ]),
      ).resolves.toBeUndefined();
      expect((await h.readHistory(claim.key))?.recovery).toEqual(recovery);
      const saved = await h.repository.save(
        claim,
        { meetingName: "Synthetic name" },
        NOW + 2,
        undefined,
        undefined,
        ["recovery"],
      );
      expect(saved).toMatchObject({ meetingName: "Synthetic name" });
      expect(saved).not.toHaveProperty("recovery");
      await expect(h.readHistory(claim.key)).resolves.toEqual(saved);
    });

    it("save with an empty patch still proves the claim and bumps updatedAt", async () => {
      const claim = await claimed();
      const saved = await h.repository.save(claim, {}, NOW + 5);
      expect(saved?.updatedAt).toBe(new Date((NOW + 5) * 1000).toISOString());
      await expect(
        h.repository.save(claim, {}, NOW + CLAIM + 1),
      ).resolves.toBeUndefined();
    });

    it("releaseDone removes the finish map", async () => {
      const claim = await claimed();
      await h.repository.releaseDone(claim);
      expect(await h.readHistory(claim.key)).not.toHaveProperty("finish");
    });

    it("releaseForRetry keeps attempts and sets nextAttemptAt while dropping the owner", async () => {
      const claim = await claimed();
      await h.repository.releaseForRetry(claim, {
        attempts: 1,
        nextAttemptAt: NOW + 60,
        phase: "process",
      });
      expect((await h.readHistory(claim.key))?.finish).toEqual({
        attempts: 1,
        nextAttemptAt: NOW + 60,
        phase: "process",
      });
    });

    it("releaseUnclaimed keeps counters and drops the owner and expiry", async () => {
      const claim = await claimed();
      await h.repository.releaseUnclaimed(claim);
      expect((await h.readHistory(claim.key))?.finish).toEqual({
        attempts: 0,
        startedAt: NOW,
        phase: "process",
      });
    });

    it("releaseUnclaimed keeps the phase the attempt reached", async () => {
      const claim = await claimed();
      await h.repository.save(
        claim,
        {
          status: "complete",
          finish: {
            owner: claim.owner,
            expiresAt: NOW + CLAIM,
            attempts: 0,
            phase: "deliver",
          },
        },
        NOW,
      );
      await h.repository.releaseUnclaimed(claim);
      expect((await h.readHistory(claim.key))?.finish).toEqual({
        attempts: 0,
        phase: "deliver",
      });
    });

    it("releases are ignored once another worker holds the claim", async () => {
      const claim = await claimed();
      const later = NOW + CLAIM + 1;
      const current = await h.readHistory(claim.key);
      if (!current) throw new Error("expected the row");
      const taken = await h.repository.claim(
        finisherRow(current),
        WORKER_B,
        later,
      );
      await h.repository.releaseDone(claim);
      await h.repository.releaseForRetry(claim, {
        attempts: 3,
        phase: "process",
      });
      await h.repository.releaseUnclaimed(claim);
      await expect(h.readHistory(claim.key)).resolves.toEqual(taken?.history);
    });
  });

  describe("abandon", () => {
    it("abandon is idempotent", async () => {
      const row = await seed("a", {
        status: "processing",
        finish: { attempts: 1, phase: "process" },
      });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        true,
      );
      const failed = await h.readHistory(keyOf(row));
      expect(failed?.status).toBe("failed");
      expect(failed).not.toHaveProperty("finish");
      await expect(
        h.repository.abandon(finisherRow(row), NOW + 1),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(failed);
    });

    it("abandon records a failure before notes when no processing outcome exists", async () => {
      const row = await seed("a", { status: "in_progress" });
      await h.repository.abandon(finisherRow(row), NOW);
      expect((await h.readHistory(keyOf(row)))?.processing).toEqual({
        transcription: "failed",
        notes: "skipped",
        summary: "skipped",
      });
      const recorded = await seed("b", {
        status: "processing",
        processing: { transcription: "ready" },
      });
      await h.repository.abandon(finisherRow(recorded), NOW);
      expect((await h.readHistory(keyOf(recorded)))?.processing).toEqual({
        transcription: "ready",
      });
    });

    it("abandon refuses a row without the lifecycle marker", async () => {
      const row = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        false,
      );
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });

    it("leaves a terminal row alone", async () => {
      const row = await seed("a", { status: "complete" });
      await expect(h.repository.abandon(finisherRow(row), NOW)).resolves.toBe(
        false,
      );
      await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
    });
  });

  describe("scan", () => {
    it("scan returns only marked open rows", async () => {
      const open = [
        await seed("starting", { status: "starting" }),
        await seed("live"),
        await seed("processing", { status: "processing" }),
        await seed("delivering", {
          status: "complete",
          finish: { attempts: 1, phase: "deliver", deliverSince: NOW },
        }),
      ];
      await seed("complete", { status: "complete" });
      await seed("failed", { status: "failed" });
      await seed("legacy", {
        status: "processing",
        lifecycleVersion: undefined,
      });
      await seed("legacy-finish", {
        status: "complete",
        lifecycleVersion: undefined,
        finish: { attempts: 0, phase: "deliver" },
      });
      const rows = await collect(
        h.repository.scan(new AbortController().signal),
      );
      const byKey = (a: FinisherRow, b: FinisherRow) =>
        a.channelId_timestamp.localeCompare(b.channelId_timestamp);
      expect(rows.sort(byKey)).toEqual(open.map(finisherRow).sort(byKey));
    });

    it("projects only the finisher fields", async () => {
      await seed("a", { notes: "synthetic notes", status: "processing" });
      const [row] = await collect(
        h.repository.scan(new AbortController().signal),
      );
      expect(row).not.toHaveProperty("notes");
      expect(row).not.toHaveProperty("participants");
    });

    it("yields nothing once the signal has aborted", async () => {
      await seed("a");
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(h.repository.scan(controller.signal)),
      ).resolves.toEqual([]);
    });
  });

  describe("listStranded", () => {
    it("lists non-terminal rows without the marker", async () => {
      const stranded = [
        await seed("starting", {
          status: "starting",
          lifecycleVersion: undefined,
        }),
        await seed("processing", {
          status: "processing",
          lifecycleVersion: undefined,
        }),
      ];
      await seed("complete", {
        status: "complete",
        lifecycleVersion: undefined,
      });
      await seed("interrupted", {
        status: "interrupted",
        lifecycleVersion: undefined,
      });
      await seed("marked", { status: "processing" });
      const rows = await collect(
        h.repository.listStranded(new AbortController().signal),
      );
      const byKey = (a: MeetingHistory, b: MeetingHistory) =>
        a.channelId_timestamp.localeCompare(b.channelId_timestamp);
      expect(rows.sort(byKey)).toEqual(stranded.sort(byKey));
    });
  });
}
