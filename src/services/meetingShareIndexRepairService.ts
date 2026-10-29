import { isDeepStrictEqual } from "node:util";
import type { MeetingUserIndexRecord } from "../types/db";
import type {
  GuildShareIndexMetadata,
  MeetingBrowseStorageCursor,
} from "../types/meetingBrowse";
import { buildGuildShareIndexRecords } from "../utils/meetingUserIndex";

export type ShareIndexRepairOptions = {
  mode: "dry-run" | "apply";
  cursor?: MeetingBrowseStorageCursor;
  limit: number;
  signal?: AbortSignal;
};
export type ShareIndexInventoryPage = {
  items: GuildShareIndexMetadata[];
  examined: number;
  nextCursor?: MeetingBrowseStorageCursor;
};
export type ShareIndexRepairDependencies = {
  inventory: (
    options: Pick<ShareIndexRepairOptions, "cursor" | "limit" | "signal">,
  ) => Promise<ShareIndexInventoryPage>;
  getMetadataStrong: (
    key: Pick<GuildShareIndexMetadata, "guildId" | "channelId_timestamp">,
    signal?: AbortSignal,
  ) => Promise<GuildShareIndexMetadata | undefined>;
  pointerExistsStrong: (
    key: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  write: (records: MeetingUserIndexRecord[]) => Promise<void>;
};

type RepairCounts = {
  personalWithGuildGrants: number;
  missingPointers: number;
  written: number;
  skippedChanged: number;
  failed: number;
};
async function repairMetadata(
  metadata: GuildShareIndexMetadata,
  options: ShareIndexRepairOptions,
  dependencies: ShareIndexRepairDependencies,
  result: RepairCounts,
) {
  const canonical = await dependencies.getMetadataStrong(
    metadata,
    options.signal,
  );
  options.signal?.throwIfAborted();
  if (!canonical || !isDeepStrictEqual(canonical, metadata)) {
    result.skippedChanged++;
    return;
  }
  for (const pointer of buildGuildShareIndexRecords(canonical)) {
    options.signal?.throwIfAborted();
    if (await dependencies.pointerExistsStrong(pointer, options.signal))
      continue;
    result.missingPointers++;
    options.signal?.throwIfAborted();
    if (options.mode === "apply") {
      // Use single-record writes: after an uncertain result, issue no more writes.
      await dependencies.write([pointer]);
      options.signal?.throwIfAborted();
      result.written++;
    }
  }
}

/** One storage page only. A failed page must be replayed from its incoming cursor. */
export async function repairMeetingShareIndexPage(
  options: ShareIndexRepairOptions,
  dependencies: ShareIndexRepairDependencies,
) {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw new Error("Page limit must be between 1 and 100");
  if (options.mode !== "dry-run" && options.mode !== "apply")
    throw new Error("Invalid repair mode");
  options.signal?.throwIfAborted();
  const page = await dependencies.inventory(options);
  const result = {
    nextCursor: page.nextCursor,
    examined: page.examined,
    personalWithGuildGrants: 0,
    missingPointers: 0,
    written: 0,
    skippedChanged: 0,
    failed: 0,
  };
  for (const metadata of page.items) {
    options.signal?.throwIfAborted();
    if (buildGuildShareIndexRecords(metadata).length === 0) continue;
    result.personalWithGuildGrants++;
    try {
      await repairMetadata(metadata, options, dependencies, result);
    } catch {
      options.signal?.throwIfAborted();
      result.failed++;
      result.nextCursor = options.cursor;
      return result;
    }
  }
  return result;
}
