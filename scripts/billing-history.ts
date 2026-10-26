import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ECSClient } from "@aws-sdk/client-ecs";
import { z } from "zod";
import { getStripeClient } from "../src/services/stripeClient";
import { importHistoricalOffers } from "../src/services/historicalOfferImportService";
import {
  registerHistoryWriterBoundary,
  invalidateHistoryWriterBoundary,
} from "../src/services/historyWriterBoundaryService";
import { providerModeSchema } from "../src/types/offerUsage";

export function parseBillingHistoryArgs(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      account: { type: "string" },
      mode: { type: "string" },
      guild: { type: "string" },
      cutoff: { type: "string" },
      "max-pages": { type: "string" },
      cluster: { type: "string" },
      service: { type: "string" },
      container: { type: "string" },
      image: { type: "string" },
      revision: { type: "string" },
      report: { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { command: "help" as const };
  if (positionals.length !== 1)
    throw new Error("Choose register, import, or invalidate");
  const command = z
    .enum(["register", "import", "invalidate"])
    .parse(positionals[0]);
  const accountId = z.string().min(1).parse(values.account);
  const mode = providerModeSchema.parse(values.mode);
  const common = {
    accountId,
    mode,
    apply: values.apply,
    report: values.report,
  };
  if (command === "invalidate")
    return {
      command,
      ...common,
      expectedRevision: z.string().min(1).parse(values.revision),
    };
  const guildId = z
    .string()
    .regex(/^\d{17,20}$/)
    .parse(values.guild);
  if (command === "import")
    return {
      command,
      ...common,
      guildId,
      createdBefore: z
        .number()
        .int()
        .nonnegative()
        .parse(Number(z.string().regex(/^\d+$/).parse(values.cutoff))),
      maxPages: values["max-pages"]
        ? z.number().int().min(1).max(1000).parse(Number(values["max-pages"]))
        : 100,
    };
  return {
    command,
    ...common,
    guildId,
    target: {
      clusterArn: z.string().min(1).parse(values.cluster),
      serviceArn: z.string().min(1).parse(values.service),
      containerName: z.string().min(1).parse(values.container),
      imageDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(values.image),
    },
  };
}
async function main() {
  const args = parseBillingHistoryArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(
      "Billing history commands default to dry-run. register: --account --mode --guild --cluster --service --container --image. import: --account --mode --guild --cutoff. invalidate: --account --mode --revision. --apply enables bounded application metadata writes; --report saves private details. No command changes Stripe resources.",
    );
    return;
  }
  let result: unknown;
  if (args.command === "invalidate")
    result = { status: await invalidateHistoryWriterBoundary(args) };
  else {
    const stripe = getStripeClient();
    if (!stripe) throw new Error("Stripe is not configured");
    const ecs = new ECSClient({
      region: process.env.AWS_REGION || "us-east-1",
    });
    result =
      args.command === "register"
        ? await registerHistoryWriterBoundary({
            stripe,
            ecs,
            ...args,
            sampleGuildId: args.guildId,
          })
        : await importHistoricalOffers({
            stripe,
            ecs,
            scope: {
              guildId: args.guildId,
              accountId: args.accountId,
              mode: args.mode,
              createdBefore: args.createdBefore,
            },
            apply: args.apply,
            maxPages: args.maxPages,
          });
  }
  if (args.report) {
    await mkdir(dirname(args.report), { recursive: true });
    await writeFile(
      args.report,
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );
  }
  console.log(
    JSON.stringify(billingHistorySummary(args.command, args.mode, result)),
  );
}
export function billingHistorySummary(
  command: string,
  mode: string,
  result: unknown,
) {
  const summary = z
    .object({
      outcomes: z.array(z.object({ state: z.string(), write: z.string() })),
      unresolvedInvoices: z.number(),
      unresolvedCheckouts: z.number(),
    })
    .safeParse(result);
  if (summary.success) return { command, mode, ...summary.data };
  const status = z
    .object({ status: z.enum(["absent", "dry_run", "applied"]) })
    .safeParse(result);
  if (status.success) return { command, mode, action: status.data.status };
  const registration = z
    .object({ kind: z.enum(["dry_run", "applied"]) })
    .parse(result);
  return { command, mode, action: registration.kind };
}

if (require.main === module)
  main().catch(() => {
    console.error(
      "Billing history command failed. No success is inferred. Inspect configuration and private evidence before retrying.",
    );
    process.exitCode = 1;
  });
