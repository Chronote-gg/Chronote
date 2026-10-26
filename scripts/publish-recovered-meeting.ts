import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import { createDiscordMessageEditor } from "../src/services/discordMessageEditor";
import {
  applyRecoveryDiscordPublication,
  previewRecoveryDiscordPublication,
  reconcileRecoveryDiscordPublication,
  publicationDigest,
  publicationScopeSchema,
  recoveryDiscordPreviewSchema,
  stablePublicationJson,
  type PublicationDependencies,
  type PublicationScope,
  type RecoveryDiscordPreview,
} from "../src/services/recoveryDiscordPublication";
import { createRecoveryDiscordPublicationStore } from "../src/services/recoveryDiscordPublicationStore";

type SavedArgs = { preview: string; expectPreviewSha256: string };
type Command =
  | { kind: "preview"; scope: PublicationScope; out: string }
  | ({ kind: "apply" } & SavedArgs)
  | ({ kind: "reconcile"; confirmRunStopped?: string } & SavedArgs);
type Dependencies = {
  connect: (scope: PublicationScope) => Promise<PublicationDependencies>;
  report: (line: string) => void;
};
class InvalidInput extends Error {}
const required = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0);
const scopeFlags = [
  "account-id",
  "region",
  "table",
  "bucket",
  "guild-id",
  "meeting-key",
  "recovery-manifest-key",
];
const savedFlags = ["preview", "expect-preview-sha256"];
const allFlags = [...scopeFlags, ...savedFlags, "out", "confirm-run-stopped"];

export function parseRecoveryDiscordPublicationArgs(args: string[]): Command {
  const { values, positionals, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: Object.fromEntries(
      allFlags.map((name) => [
        name,
        { type: "string" } satisfies { type: "string" },
      ]),
    ),
  });
  const names = tokens
    .filter((token) => token.kind === "option")
    .map((token) => token.name);
  if (new Set(names).size !== names.length || positionals.length > 1)
    throw new InvalidInput();
  const mode = positionals[0] ?? "preview";
  const allowed =
    mode === "preview"
      ? [...scopeFlags, "out"]
      : mode === "reconcile"
        ? [...savedFlags, "confirm-run-stopped"]
        : savedFlags;
  if (names.some((name) => !allowed.includes(name))) throw new InvalidInput();
  if (mode === "preview")
    return {
      kind: "preview",
      out: required.parse(values.out),
      scope: publicationScopeSchema.parse({
        accountId: values["account-id"],
        region: values.region,
        table: values.table,
        bucket: values.bucket,
        guildId: values["guild-id"],
        meetingKey: values["meeting-key"],
        recoveryManifestKey: values["recovery-manifest-key"],
      }),
    };
  const saved = {
    preview: required.parse(values.preview),
    expectPreviewSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(values["expect-preview-sha256"]),
  };
  if (mode === "apply") return { kind: "apply", ...saved };
  if (mode === "reconcile")
    return {
      kind: "reconcile",
      ...saved,
      ...(values["confirm-run-stopped"] === undefined
        ? {}
        : { confirmRunStopped: required.parse(values["confirm-run-stopped"]) }),
    };
  throw new InvalidInput();
}

async function privateDirectory(path: string) {
  const directory = resolve(path);
  await mkdir(directory, { mode: 0o700 });
  if (process.platform === "win32") {
    // Windows ignores POSIX modes. Install an owner-only inheritable ACL before writing content.
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$path = '${directory.replace(/'/g, "''")}'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
[System.IO.Directory]::SetAccessControl($path, $acl)
$check = [System.IO.Directory]::GetAccessControl($path)
if (-not $check.AreAccessRulesProtected -or $check.Access.Count -ne 1 -or $check.Access[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Private directory ACL verification failed' }
`;
    await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true },
    );
  }
  return directory;
}
async function privateFile(directory: string, name: string, content: string) {
  const file = await open(join(directory, name), "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
  } finally {
    await file.close();
  }
}
function reviewMarkdown(preview: RecoveryDiscordPreview) {
  const lines = [
    "# Recovery Discord publication preview",
    "",
    `Status: ${preview.kind}`,
    `Preview SHA-256: ${preview.previewDigest}`,
    "",
    "Review every target and all preserved warnings before approving this digest.",
    "",
  ];
  for (const blocker of preview.blockers) lines.push(`Blocked: ${blocker}`, "");
  for (const target of preview.targets) {
    lines.push(
      `## ${target.role} message ${target.messageId}`,
      "",
      target.url,
      "",
      `Unchanged: ${target.unchanged}`,
      "",
      "Before:",
      "",
      "```json",
      JSON.stringify(target.before, null, 2),
      "```",
      "",
      "After embeds:",
      "",
      "```json",
      JSON.stringify(target.afterEmbeds, null, 2),
      "```",
      "",
    );
  }
  return lines.join("\n");
}
async function readPreview(args: SavedArgs) {
  try {
    const raw: unknown = JSON.parse(await readFile(args.preview, "utf8"));
    const preview = recoveryDiscordPreviewSchema.parse(raw);
    if (
      preview.kind !== "ready" ||
      publicationDigest(raw) !== args.expectPreviewSha256 ||
      preview.previewDigest !== args.expectPreviewSha256 ||
      publicationDigest(preview) !== args.expectPreviewSha256
    )
      throw new InvalidInput();
    return preview;
  } catch {
    throw new InvalidInput();
  }
}
async function executeSaved(
  command: Exclude<Command, { kind: "preview" }>,
  deps: Dependencies,
) {
  const preview = await readPreview(command);
  const publication = await deps.connect(preview.scope);
  if (command.kind === "reconcile" && command.confirmRunStopped !== undefined) {
    const saved = await publication.storage.readReceipt(
      `${preview.binding.recoveryPrefix}discord-publication/${preview.previewDigest}/receipt.json`,
    );
    if (!saved || saved.value.runId !== command.confirmRunStopped)
      throw new InvalidInput();
  }
  const directory = await privateDirectory(
    join(dirname(resolve(command.preview)), `${command.kind}-${randomUUID()}`),
  );
  const receipt =
    command.kind === "apply"
      ? await applyRecoveryDiscordPublication(preview, publication)
      : await reconcileRecoveryDiscordPublication(preview, publication, {
          confirmRunStopped: command.confirmRunStopped,
        });
  await privateFile(directory, "receipt.json", stablePublicationJson(receipt));
  deps.report(
    `Publication ${receipt.status}; run ${receipt.runId}; receipt ${join(directory, "receipt.json")}`,
  );
  for (const message of receipt.messages)
    deps.report(`Message ${message.messageId}: ${message.state}`);
  return receipt.status === "verified" ? 0 : 1;
}

export async function runRecoveryDiscordPublication(
  args: string[],
  deps: Dependencies,
): Promise<0 | 1 | 2> {
  let command: Command;
  try {
    command = parseRecoveryDiscordPublicationArgs(args);
  } catch {
    deps.report(
      "Invalid publication arguments. See docs/operations/recovery-discord-publication.md",
    );
    return 2;
  }
  try {
    if (command.kind !== "preview") return await executeSaved(command, deps);
    const directory = await privateDirectory(command.out);
    const publication = await deps.connect(command.scope);
    const preview = await previewRecoveryDiscordPublication(
      command.scope,
      publication,
    );
    await privateFile(
      directory,
      "preview.json",
      stablePublicationJson(preview),
    );
    await privateFile(directory, "preview.md", reviewMarkdown(preview));
    deps.report(
      `Preview ${preview.kind}; targets ${preview.targets.length}; blockers ${preview.blockers.length}; SHA-256 ${preview.previewDigest}; files ${directory}`,
    );
    return preview.kind === "ready" ? 0 : 1;
  } catch (error) {
    if (error instanceof InvalidInput) {
      deps.report("Invalid saved preview, digest or stopped-run assertion");
      return 2;
    }
    deps.report(
      "Publication did not complete. Inspect durable state before retrying; provider details and meeting content are not logged.",
    );
    return 1;
  }
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clients: Array<DynamoDBClient | S3Client | STSClient> = [];
  try {
    process.exitCode = await runRecoveryDiscordPublication(
      process.argv.slice(2),
      {
        report: (line) => process.stdout.write(`${line}\n`),
        connect: async (scope) => {
          if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
          const resolver = new DynamoDBClient({
            region: scope.region,
            maxAttempts: 1,
          });
          let credentials;
          try {
            credentials = await resolver.config.credentials();
          } finally {
            resolver.destroy();
          }
          const config = { region: scope.region, maxAttempts: 1, credentials };
          const dynamo = new DynamoDBClient(config);
          const s3 = new S3Client(config);
          const sts = new STSClient(config);
          clients.push(dynamo, s3, sts);
          return {
            ...(await createRecoveryDiscordPublicationStore({
              dynamo,
              s3,
              sts,
              scope,
            })),
            discord: createDiscordMessageEditor({ token }),
            now: () => new Date().toISOString(),
          };
        },
      },
    );
  } finally {
    for (const client of clients) client.destroy();
  }
}
if (require.main === module)
  void main().catch(() => {
    process.stderr.write(
      "Publication runtime failed. No provider details logged.\n",
    );
    process.exitCode = 1;
  });
