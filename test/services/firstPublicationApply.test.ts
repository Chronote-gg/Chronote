/** @jest-environment node */
import {
  paginatedWorkflowFixture,
  workflowFixture,
} from "./firstPublication.harness";
import { previewFirstPublication } from "../../src/services/firstPublicationPlan";
import { applyFirstPublication } from "../../src/services/firstPublicationService";
import { DiscordMessageHttpError } from "../../src/services/discordMessageEditor";
test("approved apply sends exact notes, registers IDs and reruns without writes", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps);
  const r = await applyFirstPublication(p, p.digest, f.deps);
  expect(r.meetings[0].outcome).toBe("verified");
  expect(f.posts).toHaveLength(1);
  expect(await f.repo.getStrong(f.key)).toMatchObject({
    notesMessageIds: ["901"],
    notesVersion: 2,
    notes: f.row.notes,
    updateDelivery: { policy: { kind: "held", reason: "stored_only" } },
  });
  expect(
    (await applyFirstPublication(p, p.digest, f.deps)).meetings[0].outcome,
  ).toBe("already_published");
  expect(f.posts).toHaveLength(1);
});
test("digest or mutable source drift blocks before any send", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps);
  await expect(applyFirstPublication(p, "bad", f.deps)).rejects.toThrow();
  f.store.archive(f.key, true);
  expect(
    (await applyFirstPublication(p, p.digest, f.deps)).meetings[0].outcome,
  ).toBe("blocked");
  expect(f.posts).toHaveLength(0);
});
test("lost POST response retains authority and blocks blind resend", async () => {
  const f = workflowFixture(),
    p = await previewFirstPublication([f.key], f.deps);
  f.deps.discord.createNotesMessage = async () => {
    throw Error("connection lost");
  };
  expect(
    (await applyFirstPublication(p, p.digest, f.deps)).meetings[0].outcome,
  ).toBe("uncertain");
  expect(f.store.archive(f.key, true)).toBe("conflict");
  expect(
    (await applyFirstPublication(p, p.digest, f.deps)).meetings[0].outcome,
  ).toBe("blocked");
});
test("definite page-two rejection retains the verified first page and pin", async () => {
  const f = paginatedWorkflowFixture();
  const p = await previewFirstPublication([f.key], f.deps),
    send = f.deps.discord.createNotesMessage;
  let n = 0;
  f.deps.discord.createNotesMessage = async (input) => {
    if (++n === 2) throw new DiscordMessageHttpError("create", 403);
    return send(input);
  };
  const r = await applyFirstPublication(p, p.digest, f.deps);
  expect(r.meetings[0].outcome).toBe("partial");
  expect(f.posts).toHaveLength(1);
  expect(f.store.archive(f.key, true)).toBe("conflict");
});
