/** @jest-environment node */
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { fixture } from "../services/meetingUpdatePlan.fixture";
import { key } from "../types/meetingUpdateDelivery.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import {
  publicationSnapshot,
  publicationSnapshotDigest,
} from "../../src/types/meetingPublication";

describe("shared publication exclusion on fresh real Dynamo", () => {
  let f: Awaited<ReturnType<typeof publicationDynamoFixture>>;
  beforeEach(async () => {
    f = await publicationDynamoFixture();
  });
  afterEach(async () => {
    await f.close();
  });
  function repairOwner(
    row: ReturnType<typeof fixture>["history"],
    runId = "repair-original",
  ) {
    return {
      kind: "running" as const,
      runId,
      previewDigest: "a".repeat(64),
      receiptKey: "synthetic/receipt.json",
      snapshot: publicationSnapshotDigest(row),
    };
  }
  function acquireRepair(
    row: ReturnType<typeof fixture>["history"],
    owner = repairOwner(row),
  ) {
    return f.publication.acquireRepair({
      key,
      expected: publicationSnapshot(row),
      owner,
    });
  }
  async function seeded() {
    const input = fixture();
    input.history.status = "complete";
    await f.put(f.tables.meetingHistory, input.history);
    const plan = planMeetingUpdate(input);
    if (plan.kind !== "ready")
      throw new Error("Synthetic planner must prepare notes");
    return { input, plan, authority: await f.admit() };
  }
  function claimUpdate({
    input,
    plan,
    authority,
  }: Awaited<ReturnType<typeof seeded>>) {
    return f.updates.claim({
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: input.history.updateDelivery.revision,
      attempt: plan.attempt,
      authority,
    });
  }
  test("repair acquiring first excludes update claim without an extra worker lock", async () => {
    const { input, plan, authority } = await seeded();
    const owner = repairOwner(input.history);
    expect(await acquireRepair(input.history, owner)).toBe("owned");
    expect(await claimUpdate({ input, plan, authority })).toBe("stale");
    const row = await f.read();
    expect(row?.publicationRepair).toEqual(owner);
    expect(row?.updateDelivery?.progress.kind).toBe("pending");
    expect(row?.updateDeliveryDueAt).toBeUndefined();
  });
  test("update acquiring first excludes repair and stale preview snapshots", async () => {
    const { input, plan, authority } = await seeded();
    expect(await claimUpdate({ input, plan, authority })).toBe("claimed");
    expect(await acquireRepair(input.history, repairOwner(input.history))).toBe(
      "stale",
    );
    const row = await f.read();
    expect(row?.publicationRepair).toBeUndefined();
    expect(row?.updateDelivery?.progress.kind).toBe("running");
  });
  test("exact repair settlement preserves a newer canonical save and desired intent", async () => {
    const { input } = await seeded();
    const owner = repairOwner(input.history);
    expect(await acquireRepair(input.history, owner)).toBe("owned");
    const held = await f.read();
    if (!held?.updateDelivery) throw new Error("Expected retained delivery");
    const saved = await f.updates.updateContentAndDelivery({
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: held.updateDelivery.revision,
      expectedPublication: publicationSnapshot(held),
      mutation: { kind: "notes", notes: "Newer canonical notes" },
      notesEdit: {
        expectedNotesVersion: 2,
        editedBy: "synthetic-editor",
        source: { type: "web_editor" },
      },
      mutationId: "newer-save",
      at: Math.floor(Date.now() / 1000),
      nextDelivery: {
        ...held.updateDelivery,
        revision: "newer-intent",
        parts: {
          ...held.updateDelivery.parts,
          notesBody: { desired: 2, acknowledged: 0 },
        },
      },
    });
    expect(saved.kind).toBe("committed");
    expect(
      await f.publication.settleRepair({
        key,
        owner: { ...owner, runId: "wrong-owner" },
        evidence: { kind: "known_settled" },
        adoptVerified: true,
      }),
    ).toBe("stale");
    expect(
      await f.publication.settleRepair({
        key,
        owner,
        evidence: { kind: "known_settled" },
        adoptVerified: true,
      }),
    ).toBe("applied");
    const row = await f.read();
    expect(row).toMatchObject({
      notes: "Newer canonical notes",
      notesVersion: 3,
      contentRevision: 2,
      publicationRepair: { kind: "settled", runId: owner.runId },
    });
    expect(row?.updateDelivery).toMatchObject({
      revision: "newer-intent",
      parts: { notesBody: { desired: 2, acknowledged: 0 } },
    });
  });
  test("unsettled original publication and missing rows reject repair enrollment", async () => {
    const { input } = await seeded();
    input.history.status = "processing";
    await f.put(f.tables.meetingHistory, input.history);
    expect(await acquireRepair(input.history, repairOwner(input.history))).toBe(
      "stale",
    );
    expect(
      await f.publication.acquireRepair({
        key: { ...key, channelId_timestamp: "absent" },
        expected: publicationSnapshot(input.history),
        owner: repairOwner(input.history),
      }),
    ).toBe("stale");
  });
});
