import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { stableJson } from "../src/utils/stableJson";
import {
  createAnnouncementDeliveryStore,
  DeliveryTableMissingError,
} from "../src/services/announcements/announcementDeliveryStore";
import { createAnnouncementDiscordClient } from "../src/services/announcements/announcementDiscordClient";
import {
  type AnnouncementFormat,
  parseAnnouncement,
} from "../src/services/announcements/announcementInput";
import { previewMarkdown } from "../src/services/announcements/announcementPreviewMarkdown";
import {
  type AnnouncementPreview,
  type AnnouncementScope,
  buildAnnouncementPreview,
  previewCounts,
  previewDigest,
  type RunnerDeps,
  sendAnnouncementPreview,
  summaryLine,
} from "../src/services/announcements/announcementRunner";
import { createAnnouncementSettingsReader } from "../src/services/announcements/announcementSettingsReader";
import {
  AnnouncementInputError,
  isSnowflake,
} from "../src/services/announcements/announcementTypes";
import { privateDirectory, privateFile } from "./privateOutput";

/** A send never goes out against a target list older than this. */
const MAX_PREVIEW_AGE_MS = 60 * 60 * 1000;
const RUNBOOK = "docs/operations/operator-announcements.md";

type Command =
  | {
      kind: "preview";
      announcement: string;
      format: AnnouncementFormat;
      scope: AnnouncementScope;
      out: string;
      guildIds?: string[];
      retryFailed: boolean;
    }
  | { kind: "send"; preview: string; expectPreviewSha256: string };

export type AnnounceDeps = {
  connect: (scope: AnnouncementScope) => Promise<RunnerDeps>;
  isInteractive: () => boolean;
  report: (line: string) => void;
  /** Relative paths in arguments resolve against this directory. */
  root: string;
  signal?: AbortSignal;
};

/** A refusal the operator can act on; the message is safe to print. */
class Refusal extends Error {}

const required = z.string().trim().min(1);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const scopeSchema = z.strictObject({
  accountId: z.string().regex(/^\d{12}$/),
  region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d+$/),
  configTable: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
  deliveryTable: z.string().regex(/^[A-Za-z0-9_.-]{3,255}$/),
});
const FORMATS: Record<string, AnnouncementFormat> = {
  ".md": "markdown",
  ".json": "json",
};
const PREVIEW_FLAGS = [
  "announcement",
  "account-id",
  "region",
  "config-table",
  "delivery-table",
  "out",
  "guild-id",
  "retry-failed",
];
const SEND_FLAGS = ["preview", "expect-preview-sha256"];
const text = { type: "string" } as const;
const OPTIONS = {
  announcement: text,
  "account-id": text,
  region: text,
  "config-table": text,
  "delivery-table": text,
  out: text,
  preview: text,
  "expect-preview-sha256": text,
  "guild-id": { type: "string", multiple: true },
  "retry-failed": { type: "boolean" },
} as const;

const parseGuildIds = (values: string[] | undefined) => {
  if (values === undefined) return {};
  if (
    !values.every((value) => isSnowflake(value)) ||
    new Set(values).size !== values.length
  )
    throw new Error("invalid --guild-id");
  return { guildIds: values };
};

export function parseAnnounceArgs(args: string[]): Command {
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: OPTIONS,
  });
  const names = tokens.flatMap((token) =>
    token.kind === "option" ? [token.name] : [],
  );
  const single = names.filter((name) => name !== "guild-id");
  const mode = positionals[0] ?? "preview";
  const allowed: string[] | undefined = (
    { preview: PREVIEW_FLAGS, send: SEND_FLAGS } as Record<string, string[]>
  )[mode];
  if (
    !allowed ||
    positionals.length > 1 ||
    new Set(single).size !== single.length ||
    names.some((name) => !allowed.includes(name))
  )
    throw new Error("invalid arguments");
  if (mode === "send")
    return {
      kind: "send",
      preview: required.parse(values.preview),
      expectPreviewSha256: sha256Schema.parse(values["expect-preview-sha256"]),
    };
  const announcement = required.parse(values.announcement);
  const format = FORMATS[extname(announcement).toLowerCase()];
  if (!format) throw new Error("--announcement must be a .md or .json file");
  return {
    kind: "preview",
    announcement,
    format,
    scope: scopeSchema.parse({
      accountId: values["account-id"],
      region: values.region,
      configTable: values["config-table"],
      deliveryTable: values["delivery-table"],
    }),
    out: required.parse(values.out),
    ...parseGuildIds(values["guild-id"]),
    retryFailed: values["retry-failed"] === true,
  };
}

const outputDirectory = async (path: string) => {
  try {
    return await privateDirectory(path);
  } catch (error) {
    // Under Jest, Node fs errors are not instanceof the sandbox Error.
    if ((error as NodeJS.ErrnoException | null)?.code === "EEXIST")
      throw new Refusal(
        `Output path ${path} already exists; choose a new directory.`,
      );
    throw error;
  }
};

async function runPreview(
  command: Extract<Command, { kind: "preview" }>,
  deps: AnnounceDeps,
): Promise<0> {
  const { announcement, warnings } = parseAnnouncement(
    await readFile(resolve(deps.root, command.announcement), "utf8"),
    command.format,
  );
  const directory = await outputDirectory(resolve(deps.root, command.out));
  const preview = await buildAnnouncementPreview(
    await deps.connect(command.scope),
    {
      scope: command.scope,
      announcement,
      warnings,
      retryFailed: command.retryFailed,
      ...(command.guildIds ? { guildIds: command.guildIds } : {}),
    },
  );
  await privateFile(directory, "preview.json", stableJson(preview));
  await privateFile(directory, "preview.md", previewMarkdown(preview));
  for (const warning of preview.warnings) deps.report(`Warning: ${warning}`);
  deps.report(`Preview written to ${directory}; SHA-256 ${preview.sha256}`);
  deps.report(summaryLine(announcement.id, "preview", previewCounts(preview)));
  return 0;
}

const savedPreviewSchema = z.looseObject({
  version: z.literal(1),
  createdAt: z.iso.datetime(),
  scope: scopeSchema,
  botUserId: z.string(),
  retryFailed: z.boolean(),
  announcement: z.looseObject({ id: z.string() }),
  embed: z.looseObject({}),
  warnings: z.array(z.string()),
  entries: z.array(z.looseObject({ guildId: z.string() })),
  sha256: sha256Schema,
});

async function readApprovedPreview(path: string, expected: string) {
  let saved: z.infer<typeof savedPreviewSchema>;
  try {
    saved = savedPreviewSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Refusal(`${path} is not an announcement preview file.`);
  }
  const { sha256, ...unsigned } = saved;
  // The digest covers every field the preview wrote, so a match means this
  // is exactly the preview the operator approved.
  if (
    previewDigest(unsigned as Omit<AnnouncementPreview, "sha256">) !== sha256 ||
    sha256 !== expected
  )
    throw new Refusal(
      "The preview digest does not match the file or --expect-preview-sha256; run a fresh preview.",
    );
  return saved as unknown as AnnouncementPreview;
}

async function runSend(
  command: Extract<Command, { kind: "send" }>,
  deps: AnnounceDeps,
): Promise<0 | 1> {
  if (!deps.isInteractive())
    throw new Refusal(
      "send needs an interactive terminal; the operator runs it by hand.",
    );
  const preview = await readApprovedPreview(
    resolve(deps.root, command.preview),
    command.expectPreviewSha256,
  );
  const runner = await deps.connect(preview.scope);
  if (
    runner.now().getTime() - Date.parse(preview.createdAt) >
    MAX_PREVIEW_AGE_MS
  )
    throw new Refusal(
      "The preview is older than 60 minutes; run a fresh preview.",
    );
  await runner.store.assertTableExists();
  if ((await runner.discord.getBotUserId()) !== preview.botUserId)
    throw new Refusal(
      "DISCORD_BOT_TOKEN belongs to a different bot than the preview.",
    );
  const counts = await sendAnnouncementPreview(runner, preview, {
    signal: deps.signal,
    onEntry: deps.report,
  });
  deps.report(summaryLine(preview.announcement.id, "send", counts));
  return counts.failed + counts.unknown === 0 && !deps.signal?.aborted ? 0 : 1;
}

/** Exit 0 done, 1 incomplete or failed, 2 refused or invalid input. */
export async function runAnnounce(
  args: string[],
  deps: AnnounceDeps,
): Promise<0 | 1 | 2> {
  let command: Command;
  try {
    command = parseAnnounceArgs(args);
  } catch {
    deps.report(`Invalid announce arguments. See ${RUNBOOK}`);
    return 2;
  }
  try {
    return command.kind === "preview"
      ? await runPreview(command, deps)
      : await runSend(command, deps);
  } catch (error) {
    if (
      error instanceof Refusal ||
      error instanceof DeliveryTableMissingError
    ) {
      deps.report(error.message);
      return 2;
    }
    if (error instanceof AnnouncementInputError) {
      deps.report("Announcement input is invalid:");
      for (const problem of error.problems) deps.report(`- ${problem}`);
      return 2;
    }
    deps.report(
      `Announcement ${command.kind} did not complete: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("Interrupted; stopping before the next server.\n");
    controller.abort();
  });
  const clients: Array<DynamoDBClient | STSClient> = [];
  try {
    process.exitCode = await runAnnounce(process.argv.slice(2), {
      root: process.cwd(),
      isInteractive: () => process.stdin.isTTY === true,
      report: (line) => process.stdout.write(`${line}\n`),
      signal: controller.signal,
      connect: async (scope) => {
        if (!token) throw new Error("DISCORD_BOT_TOKEN is not set");
        const sts = new STSClient({ region: scope.region, maxAttempts: 1 });
        clients.push(sts);
        // Resolve once so every read and write uses the identity STS verified.
        const credentials = await sts.config.credentials();
        const identity = await sts.send(new GetCallerIdentityCommand({}));
        if (identity.Account !== scope.accountId)
          throw new Error("AWS caller account does not match --account-id");
        const dynamo = new DynamoDBClient({
          region: scope.region,
          maxAttempts: 1,
          credentials,
        });
        clients.push(dynamo);
        return {
          discord: createAnnouncementDiscordClient({ token }),
          store: createAnnouncementDeliveryStore({
            dynamo,
            tableName: scope.deliveryTable,
          }),
          settings: createAnnouncementSettingsReader({
            dynamo,
            tableName: scope.configTable,
          }),
          now: () => new Date(),
          sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
        };
      },
    });
  } finally {
    for (const client of clients) client.destroy();
  }
}

if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `Announcement runtime failed: ${error instanceof Error ? error.name : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
