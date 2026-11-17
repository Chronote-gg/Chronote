import type { FinishClaim } from "../../src/repositories/meetingFinishRepository";
import type { MeetingHistory } from "../../src/types/db";
import {
  CLAIM,
  FIFTEEN_SECONDS,
  NOW,
  RENEW_SECONDS,
  WORKER_A,
  WORKER_B,
  derivedEnd,
  doneRecovery,
  finisherRow,
  keyOf,
  unfinishedRecovery,
  type ContractContext,
} from "./meetingFinishRepository.contract.fixture";

const reopening = { operator: true, reopen: true };

export function claimContract({ h, seed }: ContractContext) {
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

  describe("restoreStranded", () => {
    const strandedRow = (id: string) =>
      seed(id, {
        lifecycleVersion: undefined,
        updatedAt: "2026-01-01T00:01:00.000Z",
      });

    async function operatorClaimed(overrides: Partial<MeetingHistory> = {}) {
      const before = await seed("a", {
        status: "processing",
        lifecycleVersion: undefined,
        ...overrides,
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        { operator: true },
      );
      if (!claim) throw new Error("expected the operator claim");
      return { before, claim };
    }

    /** The restore succeeds and the row reads back exactly as it was before the attempt. */
    async function expectRestored(claim: FinishClaim, before: MeetingHistory) {
      await expect(h.repository.restoreStranded(claim, before)).resolves.toBe(
        true,
      );
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(before);
    }

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
      await expectRestored(claim, before);
    });

    it("keeps a transcript key the row already had", async () => {
      const { before, claim } = await operatorClaimed({
        transcriptS3Key: "synthetic/earlier.json",
      });
      await expectRestored(claim, before);
    });

    it("puts back the finish marker the row had before", async () => {
      const { before, claim } = await operatorClaimed({
        finish: { attempts: 1, phase: "process" },
      });
      await h.repository.save(
        claim,
        { transcriptS3Key: "synthetic/transcript.json" },
        NOW,
      );
      await expectRestored(claim, before);
    });

    it("a reopening claim sets a notes-less terminal row to processing, and restore puts back its status and recovery", async () => {
      const before = await seed("a", {
        status: "interrupted",
        lifecycleVersion: undefined,
        recovery: unfinishedRecovery,
      });
      const claim = await h.repository.claim(
        finisherRow(before),
        WORKER_B,
        NOW,
        reopening,
      );
      expect(claim?.history).toMatchObject({
        status: "processing",
        recovery: unfinishedRecovery,
        finish: { owner: WORKER_B },
      });
      if (!claim) throw new Error("expected the reopening claim");
      await h.repository.save(
        claim,
        { transcriptS3Key: "synthetic/transcript.json" },
        NOW,
      );
      await expectRestored(claim, before);
    });

    it("a reopening claim takes a row whose notes are empty", async () => {
      const row = await seed("a", {
        status: "failed",
        lifecycleVersion: undefined,
        recovery: unfinishedRecovery,
        notes: "",
      });
      const claim = await h.repository.claim(
        finisherRow(row),
        WORKER_B,
        NOW,
        reopening,
      );
      expect(claim?.history.status).toBe("processing");
    });

    it("a reopening claim refuses saved notes, a finished recovery, or a completed or cancelled meeting", async () => {
      const legacy = { status: "failed", lifecycleVersion: undefined } as const;
      const unfinished = { ...legacy, recovery: unfinishedRecovery };
      const rows = [
        await seed("notes", { ...unfinished, notes: "synthetic notes" }),
        await seed("done", { ...legacy, recovery: doneRecovery }),
        await seed("absent", legacy),
        await seed("complete", { ...unfinished, status: "complete" }),
        await seed("cancelled", { ...unfinished, status: "cancelled" }),
      ];
      for (const row of rows) {
        await expect(
          h.repository.claim(finisherRow(row), WORKER_B, NOW, reopening),
        ).resolves.toBeUndefined();
        await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
      }
    });

    it("refuses while another owner holds the claim", async () => {
      const { before, claim } = await operatorClaimed();
      await expect(
        h.repository.restoreStranded({ ...claim, owner: WORKER_A }, before),
      ).resolves.toBe(false);
      await expect(h.readHistory(keyOf(before))).resolves.toEqual(
        claim.history,
      );
    });

    it("refuses a row that reached a terminal status or carries the marker", async () => {
      const { before, claim } = await operatorClaimed();
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
}
