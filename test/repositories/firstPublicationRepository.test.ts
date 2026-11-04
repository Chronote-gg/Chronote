/** @jest-environment node */
import {
  createFirstPublicationRepository,
  createMemoryFirstPublicationStore,
} from "../../src/repositories/firstPublicationRepository";
import { firstPublicationFixture } from "../services/firstPublication.fixture";
import { firstPublicationSnapshot } from "../../src/services/firstPublicationSource";
import {
  digest,
  type FirstPublicationReceipt,
} from "../../src/services/firstPublicationTypes";
function fixture() {
  const f = firstPublicationFixture();
  const snapshot = firstPublicationSnapshot(f.row);
  const store = createMemoryFirstPublicationStore([f.row], {
    pk: "ENV",
    sk: "CONTROL",
    servingGeneration: 1,
    coordinatorEpoch: 1,
  });
  const repo = createFirstPublicationRepository(store);
  const receipt: FirstPublicationReceipt = {
    schemaVersion: 1,
    runId: "run",
    generation: 1,
    authority: "authority",
    key: f.key,
    planDigest: "approved",
    sourceDigest: digest(snapshot),
    channelId: "789",
    botId: "999",
    payloads: [
      {
        embeds: [{ description: "x" }],
        components: [],
        allowed_mentions: { parse: [] },
      },
    ],
    pages: [{ kind: "prepared" }],
    ownerState: "running",
    outcome: "pending",
    updatedAt: "2026-11-02T09:00:00Z",
    processId: "test",
  };
  const runtime = {
    kind: "compatible" as const,
    generation: 1,
    control: store.control,
  };
  return { ...f, store, repo, receipt, snapshot, runtime };
}
test("batch acquisition pins and fences exact rows, other previews cannot bypass", async () => {
  const f = fixture();
  expect(
    await f.repo.acquire({
      receipt: f.receipt,
      snapshot: f.snapshot,
      runtime: f.runtime,
    }),
  ).toBe("owned");
  expect(f.store.control.publicationPins).toBeDefined();
  expect(
    await f.repo.acquire({
      receipt: { ...f.receipt, runId: "other" },
      snapshot: f.snapshot,
      runtime: f.runtime,
    }),
  ).toBe("stale");
});
test("archive and incompatible deployment cannot win after acquisition", async () => {
  const f = fixture();
  await f.repo.acquire({
    receipt: f.receipt,
    snapshot: f.snapshot,
    runtime: f.runtime,
  });
  expect(f.store.archive(f.key, true)).toBe("conflict");
  expect(f.store.reserveIncompatible()).toBe("stale");
});
test("verified settlement preserves canonical text and holds, releases final pin", async () => {
  const f = fixture();
  await f.repo.acquire({
    receipt: f.receipt,
    snapshot: f.snapshot,
    runtime: f.runtime,
  });
  const verified = {
    ...f.receipt,
    pages: [
      {
        kind: "verified" as const,
        at: f.receipt.updatedAt,
        messageId: "900",
        fingerprint: "hash",
      },
    ],
  };
  const submitted = {
    ...f.receipt,
    pages: [{ kind: "submitted" as const, at: f.receipt.updatedAt }],
  };
  expect(await f.repo.recordPage(f.receipt, submitted)).toBe("applied");
  expect(await f.repo.recordPage(submitted, verified)).toBe("applied");
  expect(await f.repo.settleVerified(verified, f.snapshot)).toBe("applied");
  const row = await f.repo.getStrong(f.key);
  expect(row).toMatchObject({
    notes: f.row.notes,
    notesVersion: 2,
    notesMessageIds: ["900"],
    notesChannelId: "789",
    updateDelivery: { policy: { kind: "held", reason: "stored_only" } },
  });
  expect(f.store.control.publicationPins).toEqual({});
  expect(f.store.archive(f.key, true)).toBe("applied");
});
test("no-send retirement rejects partial and unknown sends", async () => {
  for (const page of [
    { kind: "submitted" as const, at: "now" },
    {
      kind: "verified" as const,
      at: "now",
      messageId: "900",
      fingerprint: "hash",
    },
  ]) {
    const f = fixture();
    await f.repo.acquire({
      receipt: f.receipt,
      snapshot: f.snapshot,
      runtime: f.runtime,
    });
    const after = { ...f.receipt, pages: [page] };
    await f.repo.recordPage(f.receipt, after);
    expect(await f.repo.settleUnsent(after, f.snapshot)).toBe("stale");
  }
});
test("archive or incompatible transition before acquisition prevents writes", async () => {
  const f = fixture();
  f.store.archive(f.key, true);
  expect(
    await f.repo.acquire({
      receipt: f.receipt,
      snapshot: f.snapshot,
      runtime: f.runtime,
    }),
  ).toBe("stale");
  const g = fixture();
  g.store.reserveIncompatible();
  expect(
    await g.repo.acquire({
      receipt: g.receipt,
      snapshot: g.snapshot,
      runtime: g.runtime,
    }),
  ).toBe("stale");
});
