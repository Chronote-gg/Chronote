/** @jest-environment node */
import { createMockMeetingPublicationRepository } from "../../src/repositories/meetingPublicationRepository";
import {
  initialMeetingUpdatePolicy,
  publicationSnapshot,
  publicationSnapshotDigest,
  type RepairPublicationOwner,
} from "../../src/types/meetingPublication";
import {
  history,
  key,
  pointers,
  pending,
} from "../types/meetingUpdateDelivery.fixture";
import type { MeetingHistory } from "../../src/types/db";

async function repairFixture(row: MeetingHistory) {
  const histories = new Map([[key.guildId, [row]]]);
  const repository = createMockMeetingPublicationRepository(histories);
  const owner: RepairPublicationOwner = {
    kind: "running",
    runId: "synthetic-run",
    previewDigest: "a".repeat(64),
    receiptKey: "synthetic/receipt.json",
    snapshot: publicationSnapshotDigest(row),
  };
  expect(
    await repository.acquireRepair({
      key,
      expected: publicationSnapshot(row),
      owner,
    }),
  ).toBe("owned");
  return { row, repository, owner };
}
test.each(["failed", "running"] as const)(
  "a %s legacy repair cannot enroll ordinary edits",
  async (outcome) => {
    const { row, repository, owner } = await repairFixture({
      ...history(),
      ...pointers,
      operatorRecovery: { state: "known" },
    });
    if (outcome === "failed") {
      expect(
        await repository.settleRepair({
          key,
          owner,
          evidence: { kind: "known_settled" },
          adoptVerified: false,
        }),
      ).toBe("applied");
      expect(row.publicationRepair?.kind).toBe("settled");
    } else expect(row.publicationRepair?.kind).toBe("running");
    expect(row.updateDelivery).toBeUndefined();
    expect(initialMeetingUpdatePolicy(row)).toEqual({
      kind: "held",
      reason: "legacy_publication_unknown",
    });
  },
);
test("verified repair keeps an explicit stored-only hold", async () => {
  const { row, repository, owner } = await repairFixture({
    ...history(),
    ...pointers,
    contentRevision: 1,
    updateDelivery: {
      ...pending(),
      policy: { kind: "held", reason: "stored_only" },
    },
  });
  expect(
    await repository.settleRepair({
      key,
      owner,
      evidence: { kind: "known_settled" },
      adoptVerified: true,
    }),
  ).toBe("applied");
  expect(row.updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "stored_only",
  });
});
test("changed canonical snapshot does not acquire verified legacy enrollment", async () => {
  const { row, repository, owner } = await repairFixture({
    ...history(),
    ...pointers,
    operatorRecovery: { state: "known" },
  });
  row.notes = "Newer canonical notes";
  row.contentRevision = 1;
  row.updateDelivery = {
    ...pending(),
    policy: { kind: "held", reason: "legacy_publication_unknown" },
  };
  expect(
    await repository.settleRepair({
      key,
      owner,
      evidence: { kind: "known_settled" },
      adoptVerified: true,
    }),
  ).toBe("applied");
  expect(row.notes).toBe("Newer canonical notes");
  expect(row.updateDelivery.policy).toEqual({
    kind: "held",
    reason: "legacy_publication_unknown",
  });
});
test("stopped-run evidence must identify the exact retained owner", async () => {
  const { row, repository, owner } = await repairFixture({
    ...history(),
    ...pointers,
  });
  await expect(
    repository.settleRepair({
      key,
      owner,
      evidence: { kind: "confirmed_stopped", runId: "different" },
      adoptVerified: true,
    }),
  ).rejects.toThrow("exact database owner");
  expect(row.publicationRepair?.kind).toBe("running");
  expect(row.updateDelivery).toBeUndefined();
});
