import type { MeetingHistory } from "../../src/types/db";
import { autoRecordCompletionPolicy } from "../fixtures/completionPolicy";
import {
  CLAIM,
  NOW,
  WORKER_A,
  WORKER_B,
  capturePatch,
  derivedEnd,
  finisherRow,
  keyOf,
  leaseFor,
  reservationFor,
  type ContractContext,
} from "./meetingFinishRepository.contract.fixture";

export function captureEndContract({ h, seed }: ContractContext) {
  /** A capture end under this worker's claim is refused and the row is left as it was. */
  async function expectClaimedCaptureEndRefused(row: MeetingHistory) {
    await expect(
      h.repository.recordCaptureEnd({
        reservation: reservationFor(row),
        patch: capturePatch,
        claimOwner: WORKER_A,
        now: NOW,
      }),
    ).resolves.toBe(false);
    await expect(h.readHistory(keyOf(row))).resolves.toEqual(row);
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
      const completionPolicy = autoRecordCompletionPolicy({
        elapsedMilliseconds: 1_000,
        dismissed: true,
        decision: "cancel",
      });
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
      await expectClaimedCaptureEndRefused(row);
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
      await expectClaimedCaptureEndRefused(row);
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
}
