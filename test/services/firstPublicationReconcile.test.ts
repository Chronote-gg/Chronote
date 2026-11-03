/** @jest-environment node */
import { workflowFixture } from "./firstPublication.harness";
import { previewFirstPublication } from "../../src/services/firstPublicationPlan";
import {
  applyFirstPublication,
  statusFirstPublication,
  reconcileFirstPublication,
} from "../../src/services/firstPublicationService";
test("read-only status verifies a successful apply and cannot create more posts", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps);
  await applyFirstPublication(p, p.digest, f.deps);
  expect((await statusFirstPublication(p, f.deps)).meetings[0].outcome).toBe(
    "already_published",
  );
  expect((await reconcileFirstPublication(p, f.deps)).resolution).toBeNull();
  expect(f.posts).toHaveLength(1);
});
test("known-ID read failure produces a conditional finalize plan with zero resend", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps),
    get = f.deps.discord.getMessage;
  f.deps.discord.getMessage = async () => {
    throw Error("read unavailable");
  };
  await applyFirstPublication(p, p.digest, f.deps);
  f.deps.discord.getMessage = get;
  const before = JSON.stringify([...f.store.attempts]);
  const r = await reconcileFirstPublication(p, f.deps);
  expect(JSON.stringify([...f.store.attempts])).toBe(before);
  expect(r.resolution?.operation).toBe("finalize");
  if (!r.resolution) throw Error("missing resolution");
  f.deps.processId = "local:next";
  expect(
    (await applyFirstPublication(r.resolution, r.resolution.digest, f.deps))
      .meetings[0].outcome,
  ).toBe("verified");
  expect(f.posts).toHaveLength(1);
});
test("lost ID cannot be resolved by stopped-run or empty search evidence", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps);
  f.deps.discord.createNotesMessage = async () => {
    throw Error("lost");
  };
  await applyFirstPublication(p, p.digest, f.deps);
  const r = await reconcileFirstPublication(p, f.deps);
  expect(r.resolution).toBeNull();
  expect(r.result.meetings[0].outcome).toBe("uncertain");
  expect(f.store.archive(f.key, true)).toBe("conflict");
});

test("continuation reuses verified pages and sends only a positively rejected remainder", async () => {
  const f = workflowFixture();
  f.row.notes = f.objects.notes = "paragraph ".repeat(1600);
  const { hash } = await import("./firstPublication.fixture");
  f.row.operatorRecovery!.notesSha256 = hash(f.objects.notes);
  f.manifest.objects[0].sha256 = hash(f.objects.notes);
  f.store.rows.set(
    f.key.guildId + "/" + f.key.channelId_timestamp,
    structuredClone(f.row),
  );
  const p = await previewFirstPublication([f.key], f.deps),
    send = f.deps.discord.createNotesMessage;
  let n = 0;
  const { DiscordMessageHttpError } =
    await import("../../src/services/discordMessageEditor");
  f.deps.discord.createNotesMessage = async (input) => {
    if (++n === 2) throw new DiscordMessageHttpError("create", 403);
    return send(input);
  };
  await applyFirstPublication(p, p.digest, f.deps);
  const r = await reconcileFirstPublication(p, f.deps);
  expect(r.resolution?.operation).toBe("continue");
  if (!r.resolution) throw Error("missing");
  f.deps.discord.createNotesMessage = send;
  f.deps.processId = "local:resumed";
  expect(
    (await applyFirstPublication(r.resolution, r.resolution.digest, f.deps))
      .meetings[0].outcome,
  ).toBe("verified");
  const original = p.meetings[0];
  if (original.outcome !== "ready") throw Error("missing");
  expect(f.posts).toHaveLength(original.binding.payloads.length);
});
