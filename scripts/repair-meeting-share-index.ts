import { parseArgs } from "node:util";
import { z } from "zod";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ShareIndexRepairOptions,
  repairMeetingShareIndexPage,
} from "../src/services/meetingShareIndexRepairService";

const argsSchema = z.object({
  expectedAccount: z.string().regex(/^\d{12}$/),
  historyTable: z.string().min(3),
  indexTable: z.string().min(3),
  checkpoint: z.string().min(1),
  mode: z.enum(["dry-run", "apply"]),
  limit: z.coerce.number().int().min(1).max(100),
  maxPages: z.coerce.number().int().min(1).max(10000),
});

export function parseRepairMeetingShareIndexArgs(args: string[]) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      "expected-account": { type: "string" },
      "history-table": { type: "string" },
      "index-table": { type: "string" },
      checkpoint: { type: "string" },
      limit: { type: "string", default: "100" },
      "max-pages": { type: "string", default: "1" },
      apply: { type: "boolean", default: false },
    },
  });
  return argsSchema.parse({
    expectedAccount: values["expected-account"],
    historyTable: values["history-table"],
    indexTable: values["index-table"],
    checkpoint: values.checkpoint,
    mode: values.apply ? "apply" : "dry-run",
    limit: values.limit,
    maxPages: values["max-pages"],
  });
}

type RepairArgs = ReturnType<typeof parseRepairMeetingShareIndexArgs>;
const targetSchema = z
  .object({
    account: z.string().regex(/^\d{12}$/),
    region: z.literal("us-east-1"),
    historyTable: z.string().min(3),
    indexTable: z.string().min(3),
    historyArn: z.string().min(1),
    indexArn: z.string().min(1),
    historyTableId: z.string().min(1),
    indexTableId: z.string().min(1),
  })
  .strict();
export type RepairTarget = z.infer<typeof targetSchema>;
const cursorSchema = z
  .object({
    guildId: z.object({ S: z.string().min(1) }).strict(),
    channelId_timestamp: z.object({ S: z.string().min(1) }).strict(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal(1),
    target: targetSchema,
    mode: z.enum(["dry-run", "apply"]),
    complete: z.boolean(),
    pages: z.number().int().nonnegative(),
    cursor: cursorSchema.optional(),
  })
  .strict()
  .refine((value) => !value.complete || !value.cursor);
type RepairCheckpoint = z.infer<typeof checkpointSchema>;
type RepairPage = Awaited<ReturnType<typeof repairMeetingShareIndexPage>>;
type RepairReceipt = Omit<RepairPage, "nextCursor"> & {
  mode: RepairArgs["mode"];
  pages: number;
};
type RunnerDependencies = {
  verifyTarget: () => Promise<RepairTarget>;
  page: (options: ShareIndexRepairOptions) => Promise<RepairPage>;
  emit: (receipt: RepairReceipt) => void;
};

export function assertRepairTarget(args: RepairArgs, value: unknown): void {
  const target = targetSchema.parse(value);
  if (
    target.account !== args.expectedAccount ||
    target.historyTable !== args.historyTable ||
    target.indexTable !== args.indexTable ||
    target.historyArn !==
      `arn:aws:dynamodb:${target.region}:${target.account}:table/${args.historyTable}` ||
    target.indexArn !==
      `arn:aws:dynamodb:${target.region}:${target.account}:table/${args.indexTable}`
  )
    throw new Error("Repair target identity mismatch");
}

/** Same-directory, exclusive temporary file, flushed before atomic replacement. */
export async function writeRepairCheckpointAtomic(
  path: string,
  value: unknown,
) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isMissingFile(error)) throw error;
    });
  }
}

const isMissingFile = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "ENOENT";

export async function runMeetingShareIndexRepair(
  args: RepairArgs,
  dependencies: RunnerDependencies,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const target = targetSchema.parse(await dependencies.verifyTarget());
  assertRepairTarget(args, target);
  const lockPath = `${args.checkpoint}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  try {
    let checkpoint: RepairCheckpoint;
    try {
      const raw: unknown = JSON.parse(await readFile(args.checkpoint, "utf8"));
      checkpoint = checkpointSchema.parse(raw);
      if (
        !isDeepStrictEqual(checkpoint.target, target) ||
        checkpoint.mode !== args.mode
      )
        throw new Error("Checkpoint target or mode mismatch");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      checkpoint = {
        version: 1,
        target,
        mode: args.mode,
        complete: false,
        pages: 0,
      };
      // Bind even an uncertain first page to this target and mode.
      await writeRepairCheckpointAtomic(args.checkpoint, checkpoint);
    }
    for (
      let pages = 0;
      pages < args.maxPages && !checkpoint.complete;
      pages++
    ) {
      signal?.throwIfAborted();
      const result = await dependencies.page({
        mode: args.mode,
        limit: args.limit,
        cursor: checkpoint.cursor,
        signal,
      });
      signal?.throwIfAborted();
      // Explicit fields only: never send a cursor, grants or provider errors to stdout.
      dependencies.emit({
        mode: args.mode,
        pages: pages + 1,
        examined: result.examined,
        personalWithGuildGrants: result.personalWithGuildGrants,
        missingPointers: result.missingPointers,
        written: result.written,
        skippedChanged: result.skippedChanged,
        failed: result.failed,
      });
      if (result.failed)
        throw new Error(
          "Repair page failed; resume explicitly from retained checkpoint",
        );
      const next: RepairCheckpoint = checkpointSchema.parse({
        ...checkpoint,
        pages: checkpoint.pages + 1,
        cursor: result.nextCursor,
        complete: !result.nextCursor,
      });
      await writeRepairCheckpointAtomic(args.checkpoint, next);
      checkpoint = next;
    }
    return { complete: checkpoint.complete, pages: checkpoint.pages };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Construct live adapters only for an explicit CLI invocation after arguments parse. */
async function main() {
  const args = parseRepairMeetingShareIndexArgs(process.argv.slice(2));
  const { config } = await import("../src/services/configService");
  if (config.mock.enabled || config.database.useLocalDynamoDB)
    throw new Error(
      "Repair requires explicit AWS target; mock/local modes are refused",
    );
  const { dynamoDbClient, meetingShareIndexRepairTarget } =
    await import("../src/db");
  const configured = meetingShareIndexRepairTarget();
  if (
    configured.historyTable !== args.historyTable ||
    configured.indexTable !== args.indexTable
  )
    throw new Error("Configured tables do not match explicit repair target");
  const { STSClient, GetCallerIdentityCommand } =
    await import("@aws-sdk/client-sts");
  const { DescribeTableCommand } = await import("@aws-sdk/client-dynamodb");
  const { getMeetingHistoryRepository } =
    await import("../src/repositories/meetingHistoryRepository");
  const { getMeetingUserIndexRepository } =
    await import("../src/repositories/meetingUserIndexRepository");
  const { repairMeetingShareIndexPage } =
    await import("../src/services/meetingShareIndexRepairService");
  const history = getMeetingHistoryRepository();
  const index = getMeetingUserIndexRepository();
  // Share exactly the DynamoDB client's credentials, including refresh behavior.
  const sts = new STSClient({
    region: configured.region,
    credentials: dynamoDbClient.config.credentials,
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await runMeetingShareIndexRepair(
      args,
      {
        verifyTarget: async () => {
          const caller = await sts.send(new GetCallerIdentityCommand({}), {
            abortSignal: controller.signal,
          });
          if (caller.Account !== args.expectedAccount)
            throw new Error("AWS account mismatch");
          const historyTable = await dynamoDbClient.send(
            new DescribeTableCommand({ TableName: args.historyTable }),
            { abortSignal: controller.signal },
          );
          const indexTable = await dynamoDbClient.send(
            new DescribeTableCommand({ TableName: args.indexTable }),
            { abortSignal: controller.signal },
          );
          if (
            historyTable.Table?.TableStatus !== "ACTIVE" ||
            indexTable.Table?.TableStatus !== "ACTIVE"
          )
            throw new Error("Repair target tables must be active");
          return targetSchema.parse({
            ...configured,
            account: caller.Account,
            historyArn: historyTable.Table?.TableArn,
            indexArn: indexTable.Table?.TableArn,
            historyTableId: historyTable.Table?.TableId,
            indexTableId: indexTable.Table?.TableId,
          });
        },
        page: (options) =>
          repairMeetingShareIndexPage(options, {
            inventory: history.inventoryGuildShareMetadataPage,
            getMetadataStrong: history.getGuildShareMetadataStrong,
            pointerExistsStrong: index.existsStrong,
            write: index.write,
          }),
        emit: (receipt) => process.stdout.write(JSON.stringify(receipt) + "\n"),
      },
      controller.signal,
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    sts.destroy();
    dynamoDbClient.destroy();
  }
}

if (require.main === module) {
  main().catch(() => {
    // Raw SDK and validation errors can contain identifiers or request details.
    process.stderr.write(
      "Repair stopped. Check private target configuration and retained checkpoint before explicitly resuming.\n",
    );
    process.exitCode = 1;
  });
}
