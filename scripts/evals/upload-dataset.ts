import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getLangfuseClient } from "../langfuse/client";

const CaseSchema = z.object({
  input: z.unknown(),
  expectedOutput: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** Explicit id makes re-uploads upsert instead of duplicating. */
  id: z.string().min(1).max(255).optional(),
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
  return typeof label === "string" && label.length > 0
    ? `${datasetName}:${label}`.slice(0, 255)
    : undefined;
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
  const cases = CasesSchema.parse(JSON.parse(raw));

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
    const id = resolveItemId(datasetName, item);
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
