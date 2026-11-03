/** @jest-environment node */
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFirstPublicationCli } from "../../scripts/first-publication-cli";
import { workflowFixture } from "../services/firstPublication.harness";
test("same preview/apply/status commands work without per-meeting edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-cli-")),
    f = workflowFixture(),
    lines: string[] = [];
  try {
    const selection = join(root, "selection.json");
    await writeFile(selection, JSON.stringify([f.key]));
    const out = join(root, "preview");
    const options = {
      profiles: { production: f.profile },
      connect: async () => ({ deps: f.deps, close: () => {} }),
      report: (s: string) => lines.push(s),
    };
    expect(
      await runFirstPublicationCli(
        [
          "preview",
          "--environment",
          "production",
          "--selection",
          selection,
          "--out",
          out,
        ],
        options,
      ),
    ).toBe(0);
    expect(f.posts).toHaveLength(0);
    const saved = JSON.parse(await readFile(join(out, "preview.json"), "utf8"));
    expect(
      await runFirstPublicationCli(
        [
          "apply",
          "--preview",
          join(out, "preview.json"),
          "--expect-sha256",
          saved.digest,
        ],
        options,
      ),
    ).toBe(0);
    expect(
      await runFirstPublicationCli(
        ["status", "--preview", join(out, "preview.json")],
        options,
      ),
    ).toBe(0);
    expect(f.posts).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(f.row.notes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("archived preview is successful and invalid apply cannot bypass digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "publication-cli-")),
    f = workflowFixture();
  f.row.archivedAt = "2026-11-01T00:00:00Z";
  f.store.rows.set(f.key.guildId + "/" + f.key.channelId_timestamp, f.row);
  try {
    const file = join(root, "selection.json");
    await writeFile(file, JSON.stringify([f.key]));
    const options = {
      profiles: { production: f.profile },
      connect: async () => ({ deps: f.deps, close: () => {} }),
      report: () => {},
    };
    expect(
      await runFirstPublicationCli(
        [
          "preview",
          "--environment",
          "production",
          "--selection",
          file,
          "--out",
          join(root, "preview"),
        ],
        options,
      ),
    ).toBe(0);
    expect(f.posts).toHaveLength(0);
    expect(
      await runFirstPublicationCli(
        [
          "apply",
          "--preview",
          join(root, "preview/preview.json"),
          "--expect-sha256",
          "bad",
        ],
        options,
      ),
    ).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
