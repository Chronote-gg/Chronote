/** @jest-environment node */
import {
  previewFirstPublication,
  firstPublicationDigest,
} from "../../src/services/firstPublicationPlan";
import { firstPublicationFixture } from "./firstPublication.fixture";
import type { FirstPublicationDependencies } from "../../src/services/firstPublicationTypes";
export function previewFixture() {
  const f = firstPublicationFixture(),
    trace: string[] = [];
  const deps: FirstPublicationDependencies = {
    profile: f.profile,
    now: () => "2026-11-02T09:00:00.000Z",
    processId: "local:test:1",
    identity: async () => f.profile.accountId,
    repository: {
      getStrong: async () => structuredClone(f.row),
      readAttempt: async () => null,
      acquire: async () => {
        throw Error("write");
      },
      recordPage: async () => {
        throw Error("write");
      },
      settleVerified: async () => {
        throw Error("write");
      },
      settleUnsent: async () => {
        throw Error("write");
      },
      transferStoppedRun: async () => {
        throw Error("write");
      },
    },
    readObject: async (key) => {
      trace.push("object");
      return key.endsWith("manifest.json")
        ? JSON.stringify(f.manifest)
        : key.endsWith("notes.md")
          ? f.objects.notes
          : f.objects.transcript;
    },
    targetActive: async () => false,
    runtime: async () => {
      trace.push("runtime");
      return { kind: "compatible", generation: 1, control: {} };
    },
    stopped: async () => null,
    discord: {
      getBotIdentity: async () => {
        trace.push("discord");
        return { id: "999", bot: true };
      },
      inspectDestination: async () => ({ allowed: true }),
      duplicateEvidence: async () => ({ ambiguous: false, bounds: "bounded" }),
      getMessage: async () => null,
      createNotesMessage: async () => {
        throw Error("write");
      },
    },
  };
  return { ...f, deps, trace };
}
test("preview has exact content, warnings, no pings and deterministic digest", async () => {
  const f = previewFixture();
  const p = await previewFirstPublication([f.key], f.deps);
  expect(p.ready).toBe(true);
  expect(p.digest).toBe(firstPublicationDigest(p));
  expect(await previewFirstPublication([f.key], f.deps)).toEqual(p);
  const m = p.meetings[0];
  if (m.outcome !== "ready") throw Error("not ready");
  expect(m.binding.payloads[0].embeds[0].description).toContain(f.row.notes);
  expect(m.binding.payloads[0].embeds[0].description).toContain(
    "recording was interrupted",
  );
  expect(m.binding.payloads[0].allowed_mentions).toEqual({ parse: [] });
});
test("archive skip is before token, objects and runtime and cannot silently expand", async () => {
  const f = previewFixture();
  f.row.archivedAt = "2026-11-01T00:00:00.000Z";
  const p = await previewFirstPublication([f.key], f.deps);
  expect(p.ready).toBe(true);
  expect(p.meetings).toEqual([{ key: f.key, outcome: "skipped_archived" }]);
  expect(f.trace).toEqual([]);
});
test("permissions and source problems are actionable batch blockers", async () => {
  const f = previewFixture();
  f.deps.discord.inspectDestination = async () => ({
    allowed: false,
    reason: "Missing Embed Links",
  });
  const p = await previewFirstPublication([f.key], f.deps);
  expect(p.ready).toBe(false);
  expect(p.meetings[0]).toMatchObject({
    outcome: "blocked",
    reason: expect.stringContaining("Embed Links"),
  });
});
test("long notes paginate without a code change or losing words", async () => {
  const f = previewFixture();
  f.row.notes = f.objects.notes = "paragraph ".repeat(1600);
  const { hash } = await import("./firstPublication.fixture");
  f.row.operatorRecovery!.notesSha256 = hash(f.objects.notes);
  f.manifest.objects[0].sha256 = hash(f.objects.notes);
  const p = await previewFirstPublication([f.key], f.deps);
  const m = p.meetings[0];
  if (m.outcome !== "ready") throw Error(JSON.stringify(m));
  expect(m.binding.payloads.length).toBeGreaterThan(1);
});
