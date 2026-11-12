import type { FinishClaim } from "../../src/repositories/meetingFinishRepository";
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import {
  CLAIM,
  NOW,
  WORKER_A,
  WORKER_B,
  finisherRow,
  type ContractContext,
} from "./meetingFinishRepository.contract.fixture";

export function heldClaimContract({ h, seed }: ContractContext) {
  describe("held claim", () => {
    async function claimed(id = "a") {
      const row = await seed(id, { status: "processing" });
      const claim = await h.repository.claim(finisherRow(row), WORKER_A, NOW);
      if (!claim) throw new Error("expected the claim to succeed");
      return claim;
    }

    /** Another worker takes the claim once it has expired. */
    async function takenByWorkerB(claim: FinishClaim, at: number) {
      const current = await h.readHistory(claim.key);
      if (!current) throw new Error("expected the row");
      return h.repository.claim(finisherRow(current), WORKER_B, at);
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
      const taken = await takenByWorkerB(claim, later);
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
      const taken = await takenByWorkerB(claim, later);
      await h.repository.releaseDone(claim);
      await h.repository.releaseForRetry(claim, {
        attempts: 3,
        phase: "process",
      });
      await h.repository.releaseUnclaimed(claim);
      await expect(h.readHistory(claim.key)).resolves.toEqual(taken?.history);
    });
  });
}
