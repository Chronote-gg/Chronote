/** @jest-environment node */
import { workflowFixture } from "./firstPublication.harness";
import { hash } from "./firstPublication.fixture";
import {
  previewFirstPublication,
  firstPublicationDigest,
} from "../../src/services/firstPublicationPlan";
import { applyFirstPublication } from "../../src/services/firstPublicationService";
import { firstPublicationSnapshot } from "../../src/services/firstPublicationSource";
import {
  digest,
  keyId,
  type FirstPublicationPlan,
} from "../../src/services/firstPublicationTypes";
import { assertMeetingItemSize } from "../../src/repositories/meetingUpdateDeliveryState";
import { buildFirstPublicationCommit } from "../../src/repositories/firstPublicationRepository";

function setNotes(f: ReturnType<typeof workflowFixture>, notes: string) {
  f.row.notes = f.objects.notes = notes;
  f.row.operatorRecovery!.notesSha256 = hash(notes);
  f.manifest.objects[0].sha256 = hash(notes);
  f.store.rows.set(keyId(f.key), structuredClone(f.row));
}
function largeBatch() {
  const f = workflowFixture(),
    objects = new Map<string, string>(),
    keys = [];
  f.store.rows.clear();
  for (let i = 0; i < 12; i++) {
    const g = workflowFixture();
    g.row.guildId = String(123 + i);
    g.row.meetingId =
      "22222222-2222-4222-8222-22222222222" + (i + 2).toString(16);
    g.key = {
      guildId: g.row.guildId,
      channelId_timestamp: g.row.channelId_timestamp,
    };
    const prefix = `ops/operator-recovery/${g.row.operatorRecovery!.id}/${g.row.meetingId}/`;
    g.row.transcriptS3Key = prefix + "transcript.json";
    g.row.operatorRecovery!.manifestS3Key = prefix + "manifest.json";
    g.manifest.meetingId = g.row.meetingId;
    g.manifest.key = g.key;
    for (const o of g.manifest.objects)
      o.key = prefix + o.key.split("/").at(-1);
    setNotes(g, "Approved words. ".repeat(1000));
    g.row.notesHistory = [
      {
        version: 1,
        notes: "x".repeat(320000),
        editedBy: "synthetic",
        editedAt: g.deps.now(),
      },
    ];
    objects.set(prefix + "notes.md", g.objects.notes);
    objects.set(prefix + "transcript.json", g.objects.transcript);
    objects.set(prefix + "manifest.json", JSON.stringify(g.manifest));
    f.store.rows.set(keyId(g.key), g.row);
    keys.push(g.key);
  }
  f.deps.readObject = async (key) => {
    const value = objects.get(key);
    if (!value) throw Error("Missing synthetic object");
    return value;
  };
  return { ...f, keys };
}
async function nearlyFullMeeting() {
  const f = workflowFixture();
  setNotes(f, "Approved words. ".repeat(1000));
  const plan = await previewFirstPublication([f.key], f.deps),
    meeting = plan.meetings[0];
  if (meeting.outcome !== "ready") throw Error("Fixture must start ready");
  const repair = {
    kind: "running" as const,
    purpose: "first_publication" as const,
    runId: "0".repeat(36),
    previewDigest: "0".repeat(64),
    receiptKey: meeting.binding.authority,
    snapshot: "0".repeat(64),
  };
  let low = 0,
    high = 400 * 1024;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    f.row.notesHistory = [
      {
        version: 1,
        notes: "x".repeat(mid),
        editedBy: "synthetic",
        editedAt: f.deps.now(),
      },
    ];
    try {
      assertMeetingItemSize({ ...f.row, publicationRepair: repair });
      low = mid;
    } catch {
      high = mid - 1;
    }
  }
  f.row.notesHistory![0].notes = "x".repeat(low - 1);
  assertMeetingItemSize({ ...f.row, publicationRepair: repair });
  f.store.rows.set(keyId(f.key), structuredClone(f.row));
  meeting.binding.snapshot = firstPublicationSnapshot(f.row);
  meeting.binding.sourceDigest = digest(meeting.binding.snapshot);
  plan.digest = firstPublicationDigest(plan);
  const commit = f.store.commit.bind(f.store);
  f.store.commit = async (c) => {
    buildFirstPublicationCommit(f.profile, c);
    return commit(c);
  };
  return { ...f, plan };
}

test("oversized aggregate batch is blocked before approval with a smaller-selection action", async () => {
  const f = largeBatch();
  const plan = await previewFirstPublication(f.keys, f.deps);
  expect(plan.ready).toBe(false);
  expect(plan.meetings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        outcome: "blocked",
        reason: expect.stringMatching(/4 MiB.*fewer meetings/i),
      }),
    ]),
  );
  expect(f.store.attempts.size).toBe(0);
  expect(f.posts).toHaveLength(0);
  expect(
    (await previewFirstPublication(f.keys.slice(0, 2), f.deps)).ready,
  ).toBe(true);
});

test("combining approved small previews cannot bypass the aggregate claim limit", async () => {
  const f = largeBatch(),
    meetings: FirstPublicationPlan["meetings"] = [];
  for (const key of f.keys)
    meetings.push(...(await previewFirstPublication([key], f.deps)).meetings);
  const plan: FirstPublicationPlan = {
    schemaVersion: 1,
    operation: "publish",
    profile: f.profile,
    createdAt: f.deps.now(),
    ready: true,
    meetings,
    resolution: [],
    digest: "",
  };
  plan.digest = firstPublicationDigest(plan);
  f.deps.discord.createNotesMessage = jest.fn(async () => {
    throw Error("Unexpected POST before capacity rejection");
  });
  const result = await applyFirstPublication(plan, plan.digest, f.deps);
  expect(result.meetings.every((m) => m.outcome === "blocked")).toBe(true);
  expect(f.posts).toHaveLength(0);
  expect(f.store.attempts.size).toBe(0);
  expect(f.store.control.publicationPins).toBeUndefined();
});

test("preview rejects a row that fits acquisition but has no room to register all pages", async () => {
  const f = await nearlyFullMeeting();
  const plan = await previewFirstPublication([f.key], f.deps);
  expect(plan.meetings[0]).toMatchObject({
    outcome: "blocked",
    reason: expect.stringMatching(/registration.*400 KiB/i),
  });
  expect(f.posts).toHaveLength(0);
});

test("an approved near-limit row is rejected before claims or POSTs", async () => {
  const f = await nearlyFullMeeting();
  const result = await applyFirstPublication(f.plan, f.plan.digest, f.deps);
  expect(result.meetings[0]).toMatchObject({
    outcome: "blocked",
    reason: expect.stringMatching(/registration.*400 KiB/i),
  });
  expect(f.posts).toHaveLength(0);
  expect(f.store.attempts.size).toBe(0);
  expect(f.store.control.publicationPins).toBeUndefined();
});

test("a near-limit row with room for every page still registers successfully", async () => {
  const f = await nearlyFullMeeting();
  f.row.notesHistory![0].notes = f.row.notesHistory![0].notes.slice(0, -2048);
  f.store.rows.set(keyId(f.key), structuredClone(f.row));
  const plan = await previewFirstPublication([f.key], f.deps);
  expect(plan.ready).toBe(true);
  expect(
    (await applyFirstPublication(plan, plan.digest, f.deps)).meetings[0]
      .outcome,
  ).toBe("verified");
  const stored = await f.repo.getStrong(f.key);
  expect(stored?.notesMessageIds).toHaveLength(f.posts.length);
  expect(stored?.publicationRepair?.kind).toBe("settled");
  expect(Object.keys(f.store.control.publicationPins ?? {})).toHaveLength(0);
});
