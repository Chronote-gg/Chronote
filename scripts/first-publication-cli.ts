import { readFile, mkdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { privateDirectory, privateFile } from "./publish-recovered-meeting";
import { connectFirstPublication } from "../src/services/firstPublicationConnection";
import { normalizePublicationSelection } from "../src/services/firstPublicationSource";
import { previewFirstPublication } from "../src/services/firstPublicationPlan";
import {
  applyFirstPublication,
  statusFirstPublication,
  reconcileFirstPublication,
} from "../src/services/firstPublicationService";
import {
  publicationProfileSchema,
  planSchema,
  type FirstPublicationDependencies,
  type PublicationProfile,
  type FirstPublicationPlan,
  type PublicationResult,
} from "../src/services/firstPublicationTypes";
import { stableJson } from "../src/utils/stableJson";
export type FirstPublicationCliDependencies = {
  profiles: Record<string, PublicationProfile>;
  connect(
    profile: PublicationProfile,
  ): Promise<{ deps: FirstPublicationDependencies; close(): void }>;
  report(line: string): void;
};
const escape = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
function review(plan: FirstPublicationPlan) {
  return `<!doctype html><html><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Recovered notes publication preview</title><style>body{font:16px/1.5 system-ui;max-width:1000px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-left:4px solid #667;padding:20px;margin:20px 0}</style><h1>${escape(plan.operation)}: ${plan.ready ? "ready for approval" : "blocked"}</h1><p>Preview only. No production writes. Digest: ${plan.digest}</p>${plan.meetings
    .map(
      (m) =>
        `<section><h2>${escape(m.key.channelId_timestamp)}: ${m.outcome}</h2>${
          m.outcome === "blocked"
            ? `<p>${escape(m.reason)}</p>`
            : m.outcome === "skipped_archived"
              ? "<p>Archived. No Discord calls or publication changes.</p>"
              : `<p>Destination: ${escape(m.binding.channelId)}</p>${m.binding.payloads
                  .flatMap((p) => p.embeds)
                  .map(
                    (e) =>
                      `<article><h3>${escape(e.title)}</h3><pre>${escape(e.description)}</pre><p>${escape(typeof e.footer === "object" && e.footer ? Reflect.get(e.footer, "text") : "")}</p></article>`,
                  )
                  .join(
                    "",
                  )}<details><summary>Exact payloads and conditional record changes</summary><pre>${escape(stableJson({ payloads: m.binding.payloads, expectedSourceDigest: m.binding.sourceDigest, register: "Verified returned message IDs in planned order", acknowledge: "Captured notes body only", automaticDelivery: "held", notion: "held", resolution: plan.resolution }))}</pre></details>`
        }</section>`,
    )
    .join("")}</html>`;
}
async function savePlan(path: string, plan: FirstPublicationPlan) {
  const dir = await privateDirectory(path);
  await privateFile(dir, "preview.json", stableJson(plan));
  await privateFile(dir, "preview.html", review(plan));
  await privateFile(dir, "digest.txt", plan.digest + "\n");
}
function resultCode(r: PublicationResult) {
  if (
    r.meetings.some((m) => m.outcome === "partial" || m.outcome === "uncertain")
  )
    return 3;
  if (r.meetings.some((m) => m.outcome === "blocked" || m.outcome === "unsent"))
    return r.meetings.some((m) => m.outcome === "verified") ? 3 : 2;
  return 0;
}
export async function runFirstPublicationCli(
  args: string[],
  options: FirstPublicationCliDependencies,
): Promise<number> {
  let close: (() => void) | undefined;
  try {
    const command = parseCommand(args);
    const { mode } = command;
    const plan =
      mode === "preview"
        ? undefined
        : planSchema.parse(JSON.parse(await readFile(command.preview, "utf8")));
    const profile =
      mode === "preview"
        ? publicationProfileSchema.parse(options.profiles[command.environment])
        : savedProfile(plan!, options.profiles);
    if (mode === "apply" && command["expect-sha256"] !== plan?.digest)
      throw Error("digest");
    const connection = await options.connect(profile);
    close = connection.close;
    if (mode === "preview") {
      const ready = await previewSelection(command.selection, connection.deps);
      await savePlan(command.out, ready);
      options.report(
        JSON.stringify({
          operation: "preview",
          ready: ready.ready,
          digest: ready.digest,
          meetings: ready.meetings.map((m) => ({
            key: m.key,
            outcome: m.outcome,
            ...(m.outcome === "blocked" ? { reason: m.reason } : {}),
          })),
        }),
      );
      return ready.ready ? 0 : 2;
    }
    if (!plan) throw Error("plan");
    const inspected = await inspectSavedPlan(command, plan, connection.deps);
    if (mode === "reconcile") {
      const dir = await privateDirectory(command.out);
      await privateFile(dir, "status.json", stableJson(inspected.result));
      if (inspected.resolution) {
        await privateFile(
          dir,
          "preview.json",
          stableJson(inspected.resolution),
        );
        await privateFile(dir, "preview.html", review(inspected.resolution));
        await privateFile(
          dir,
          "digest.txt",
          inspected.resolution.digest + "\n",
        );
      }
    }
    options.report(
      JSON.stringify({
        operation: mode,
        ...inspected.result,
        ...(inspected.resolution
          ? { resolutionDigest: inspected.resolution.digest }
          : {}),
      }),
    );
    return savedResultCode(mode, plan, inspected.result);
  } catch {
    options.report(
      "Invalid input or runtime operation failed. No provider content logged; inspect private evidence and use status/reconcile before retrying.",
    );
    return 1;
  } finally {
    close?.();
  }
}
export async function firstPublicationMain(args: string[]) {
  const configPath = process.env.CHRONOTE_OPERATOR_PROFILES;
  if (!configPath) throw Error("Configure CHRONOTE_OPERATOR_PROFILES");
  const config = z
    .object({
      profiles: z.record(z.string(), publicationProfileSchema),
      stateDirectory: z.string().optional(),
      releasesPath: z.string().optional(),
    })
    .strict()
    .parse(JSON.parse(await readFile(configPath, "utf8")));
  const stateDirectory = resolve(
    config.stateDirectory ?? join(dirname(configPath), "publication-runs"),
  );
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const processId = "local:" + randomUUID(),
    proofDirectory = await privateDirectory(
      join(stateDirectory, processId.slice(6)),
    );
  // Synchronous exit evidence is written only at the actual process exit event.
  process.once("exit", () => {
    try {
      writeFileSync(
        join(proofDirectory, "exited.json"),
        stableJson({ processId, exited: true }),
        { flag: "wx", mode: 0o600 },
      );
    } catch {
      /* Missing proof keeps reconciliation blocked. */
    }
  });
  return runFirstPublicationCli(args, {
    profiles: config.profiles,
    connect: (profile) =>
      connectFirstPublication(profile, {
        stateDirectory,
        processId,
        releasesPath: config.releasesPath,
      }),
    report: (line) => process.stdout.write(line + "\n"),
  });
}
if (require.main === module)
  void firstPublicationMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.stderr.write(
        "Operator configuration unavailable. No provider payloads logged.\n",
      );
      process.exitCode = 1;
    });

const previewCommand = z
  .object({
    mode: z.literal("preview"),
    environment: z.string().min(1),
    selection: z.string().min(1),
    out: z.string().min(1),
  })
  .strict();
const savedCommand = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("apply"),
      preview: z.string().min(1),
      "expect-sha256": z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ mode: z.literal("status"), preview: z.string().min(1) }).strict(),
  z
    .object({
      mode: z.literal("reconcile"),
      preview: z.string().min(1),
      out: z.string().min(1),
    })
    .strict(),
]);
function parseCommand(args: string[]) {
  const { values } = parseArgs({
    args: args.slice(1),
    strict: true,
    options: {
      environment: { type: "string" },
      selection: { type: "string" },
      out: { type: "string" },
      preview: { type: "string" },
      "expect-sha256": { type: "string" },
    },
  });
  return z
    .union([previewCommand, savedCommand])
    .parse({ mode: args[0], ...values });
}
function savedProfile(
  plan: FirstPublicationPlan,
  profiles: Record<string, PublicationProfile>,
) {
  if (
    !Object.values(profiles).some(
      (p) => stableJson(p) === stableJson(plan.profile),
    )
  )
    throw Error("unknown profile");
  return plan.profile;
}
async function previewSelection(
  selection: string,
  deps: FirstPublicationDependencies,
) {
  const raw: unknown = JSON.parse(await readFile(selection, "utf8")),
    bundles = new Map<string, unknown>();
  for (const entry of z.array(z.unknown()).parse(raw)) {
    const reference = z.object({ bundle: z.string() }).safeParse(entry);
    if (reference.success) {
      const file = resolve(dirname(selection), reference.data.bundle);
      bundles.set(
        reference.data.bundle,
        JSON.parse(await readFile(file, "utf8")),
      );
    }
  }
  return previewFirstPublication(
    normalizePublicationSelection(raw, bundles),
    deps,
  );
}
async function inspectSavedPlan(
  command: z.infer<typeof savedCommand>,
  plan: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
) {
  if (command.mode === "apply")
    return {
      result: await applyFirstPublication(plan, command["expect-sha256"], deps),
      resolution: null,
    };
  if (command.mode === "status")
    return {
      result: await statusFirstPublication(plan, deps),
      resolution: null,
    };
  return reconcileFirstPublication(plan, deps);
}

function savedResultCode(
  mode: string,
  plan: FirstPublicationPlan,
  result: PublicationResult,
) {
  return mode === "apply" &&
    plan.operation === "release" &&
    result.meetings.every((m) => m.outcome === "unsent")
    ? 0
    : resultCode(result);
}
