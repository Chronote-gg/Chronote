import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getLangfuseClient } from "../langfuse/client";

// Langfuse rejects item ids longer than this.
export const MAX_ITEM_ID_LENGTH = 255;

const CaseSchema = z.object({
  // z.unknown() alone also accepts a missing key, but every runner parses
  // `input` with a required schema, so an absent input has to fail here rather
  // than at experiment time.
  input: z.unknown().refine((value) => value !== undefined, {
    message: "input is required",
  }),
  expectedOutput: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Explicit id makes re-uploads upsert instead of duplicating. */
  id: z.string().min(1).max(MAX_ITEM_ID_LENGTH).optional(),
});
const CasesSchema = z.array(CaseSchema).min(1);

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

/**
 * Dataset items upsert on id, so a stable id keeps re-uploads idempotent.
 * `metadata.label` is the convention in this repo's case files; without either
 * an explicit id or a label, Langfuse generates one and a second upload of the
 * same file adds duplicates that quietly skew experiment scores.
 */
export const resolveItemId = (
  datasetName: string,
  item: { id?: string; metadata?: Record<string, unknown> },
): string | undefined => {
  if (item.id) return item.id;
  const label = item.metadata?.label;
  if (typeof label !== "string" || label.length === 0) return undefined;

  const id = `${datasetName}:${label}`;
  if (id.length > MAX_ITEM_ID_LENGTH) {
    // Truncating would map two labels sharing a long prefix onto one id, so the
    // second case would upsert over the first while both were reported as
    // uploaded. Losing eval coverage silently is worse than refusing the file.
    throw new Error(
      `metadata.label is too long for a dataset item id: "${label}". ` +
        `"${datasetName}:<label>" must be at most ${MAX_ITEM_ID_LENGTH} characters. ` +
        `Shorten the label or set an explicit "id".`,
    );
  }
  return id;
};

/**
 * Resolves every id before anything is written, so a bad file cannot leave a
 * half-populated dataset behind. Duplicates are rejected for the same reason
 * truncation is: a repeated id silently drops a case.
 */
export const resolveItemIds = (
  datasetName: string,
  cases: Array<{ id?: string; metadata?: Record<string, unknown> }>,
): Array<string | undefined> => {
  const ids = cases.map((item) => resolveItemId(datasetName, item));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) {
      throw new Error(
        `Duplicate dataset item id "${id}". Two cases resolve to the same id, ` +
          `so one would overwrite the other. Give them distinct labels or ids.`,
      );
    }
    seen.add(id);
  }
  return ids;
};

async function main() {
  const datasetName = parseFlagValue("--dataset");
  const file = parseFlagValue("--file");
  if (!datasetName || !file) {
    throw new Error(
      "Usage: yarn evals:upload --dataset <name> --file <cases.json> [--description <text>]",
    );
  }

  const raw = await readFile(path.resolve(file), "utf8");
  // Everything is validated before the first write: schema, then ids. A file
  // that fails here leaves the project untouched rather than half seeded.
  const cases = CasesSchema.parse(JSON.parse(raw));
  const ids = resolveItemIds(datasetName, cases);

  const langfuse = getLangfuseClient();
  await langfuse.api.datasets.create({
    name: datasetName,
    description:
      parseFlagValue("--description") ??
      `Seeded from ${path.basename(file)} by evals:upload.`,
  });
  console.log(`Dataset "${datasetName}" ready.`);

  let unstable = 0;
  for (const [index, item] of cases.entries()) {
    const id = ids[index];
    if (!id) unstable += 1;
    await langfuse.dataset.createItem({
      datasetName,
      input: item.input,
      expectedOutput: item.expectedOutput,
      metadata: item.metadata,
      id,
    });
    console.log(`  [${index + 1}/${cases.length}] ${id ?? "(generated id)"}`);
  }

  if (unstable > 0) {
    console.warn(
      `${unstable} case(s) had no id and no metadata.label, so re-running this upload will duplicate them.`,
    );
  }
  console.log(`Uploaded ${cases.length} item(s) to "${datasetName}".`);
  await langfuse.shutdown();
}

// Guarded so tests can import resolveItemId without running an upload.
if (require.main === module) {
  main().catch((error) => {
    console.error("Upload failed:", error);
    process.exit(1);
  });
}
