/** @jest-environment node */
import { repairMeetingShareIndexPage } from "../../src/services/meetingShareIndexRepairService";
import type { GuildShareIndexMetadata } from "../../src/types/meetingBrowse";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  dynamoDbClient,
  getGuildShareIndexMetadataStrong,
  inventoryGuildShareIndexMetadataPage,
  meetingShareIndexRepairTarget,
} from "../../src/db";
import { getMeetingUserIndexRepository } from "../../src/repositories/meetingUserIndexRepository";
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
import { config } from "../../src/services/configService";
import { resolvePersonalMeetingAccess } from "../../src/utils/meetingOwnership";
import { buildGuildShareIndexRecords } from "../../src/utils/meetingUserIndex";

const metadata: GuildShareIndexMetadata = {
  guildId: "personal:synthetic-owner",
  channelId_timestamp: "synthetic#2026",
  meetingId: "synthetic",
  timestamp: "2026-10-01T00:00:00.000Z",
  ownershipScope: "personal",
  ownerUserId: "synthetic-owner",
  accessGrants: [
    { targetType: "guild", guildId: "synthetic-a" },
    { targetType: "guild", guildId: "synthetic-b" },
  ],
};
const dependencies = () => ({
  inventory: jest.fn().mockResolvedValue({ items: [metadata], examined: 1 }),
  getMetadataStrong: jest.fn().mockResolvedValue(metadata),
  pointerExistsStrong: jest.fn().mockResolvedValue(false),
  write: jest.fn().mockResolvedValue(undefined),
});

afterEach(() => jest.restoreAllMocks());

test("dry-run counts multiple grants without writes, existing pointers are skipped", async () => {
  const deps = dependencies();
  deps.pointerExistsStrong.mockResolvedValueOnce(true);
  expect(
    await repairMeetingShareIndexPage({ mode: "dry-run", limit: 100 }, deps),
  ).toMatchObject({
    personalWithGuildGrants: 1,
    missingPointers: 1,
    written: 0,
  });
  expect(deps.write).not.toHaveBeenCalled();
});

test("duplicate grants generate only one write per deterministic pointer", async () => {
  const deps = dependencies();
  const duplicate = {
    ...metadata,
    accessGrants: [metadata.accessGrants![0], metadata.accessGrants![0]],
  };
  deps.inventory.mockResolvedValue({ items: [duplicate], examined: 1 });
  deps.getMetadataStrong.mockResolvedValue(duplicate);
  expect(
    await repairMeetingShareIndexPage({ mode: "apply", limit: 100 }, deps),
  ).toMatchObject({ missingPointers: 1, written: 1 });
  expect(deps.write).toHaveBeenCalledTimes(1);
});

test("mock and real write boundaries both reject an unnamespaced guild pointer", async () => {
  const pointer = {
    ...buildGuildShareIndexRecords(metadata)[0],
    userId: "synthetic-unreserved",
  };
  const send = jest
    .spyOn(dynamoDbClient, "send")
    .mockImplementation(async () => ({}));
  for (const mock of [true, false]) {
    jest.replaceProperty(config.mock, "enabled", mock);
    await expect(
      getMeetingUserIndexRepository().write([pointer]),
    ).rejects.toThrow("Invalid guild share principal");
  }
  expect(send).not.toHaveBeenCalled();
});

test("a revoked grant between inventory and strong read is skipped", async () => {
  const deps = dependencies();
  deps.getMetadataStrong.mockResolvedValue({ ...metadata, accessGrants: [] });
  expect(
    await repairMeetingShareIndexPage({ mode: "apply", limit: 100 }, deps),
  ).toMatchObject({ skippedChanged: 1, written: 0 });
  expect(deps.write).not.toHaveBeenCalled();
  expect(
    resolvePersonalMeetingAccess(
      { ...metadata, accessGrants: [] },
      "synthetic-visitor",
      ["synthetic-a"],
    ),
  ).toBeNull();
});

test("uncertain write stops the page and preserves its incoming cursor", async () => {
  const deps = dependencies();
  deps.write.mockRejectedValue(new Error("synthetic timeout"));
  const cursor = {
    guildId: { S: "synthetic-page" },
    channelId_timestamp: { S: "previous" },
  };
  expect(
    await repairMeetingShareIndexPage(
      { mode: "apply", limit: 100, cursor },
      deps,
    ),
  ).toMatchObject({ nextCursor: cursor, failed: 1, written: 0 });
  expect(deps.write).toHaveBeenCalledTimes(1);
});

test("interruption resumes by replay, deterministic keys avoid duplicate writes", async () => {
  const deps = dependencies();
  const controller = new AbortController();
  const saved = new Set<string>();
  deps.pointerExistsStrong.mockImplementation(async (pointer) =>
    saved.has(pointer.userId),
  );
  deps.write.mockImplementation(async ([pointer]) => {
    saved.add(pointer.userId);
    controller.abort();
  });
  await expect(
    repairMeetingShareIndexPage(
      { mode: "apply", limit: 100, signal: controller.signal },
      deps,
    ),
  ).rejects.toThrow();
  deps.write.mockImplementation(async ([pointer]) => {
    saved.add(pointer.userId);
  });
  expect(
    await repairMeetingShareIndexPage({ mode: "apply", limit: 100 }, deps),
  ).toMatchObject({ missingPointers: 1, written: 1 });
  expect(saved.size).toBe(2);
  expect(
    await repairMeetingShareIndexPage({ mode: "apply", limit: 100 }, deps),
  ).toMatchObject({ missingPointers: 0, written: 0 });
});

test("real repository boundaries scan metadata, strongly read, and write deterministic pointers", async () => {
  jest.replaceProperty(config.mock, "enabled", false);
  const commands: unknown[] = [];
  const send = jest.spyOn(dynamoDbClient, "send");
  send.mockImplementation(async (command) => {
    commands.push(command);
    if (command instanceof ScanCommand)
      return { Items: [marshall(metadata)], ScannedCount: 1 };
    if (command instanceof GetItemCommand)
      return command.input.TableName ===
        meetingShareIndexRepairTarget().historyTable
        ? { Item: marshall(metadata) }
        : {};
    return {};
  });
  const history = getMeetingHistoryRepository();
  const index = getMeetingUserIndexRepository();
  const result = await repairMeetingShareIndexPage(
    { mode: "apply", limit: 100 },
    {
      inventory: history.inventoryGuildShareMetadataPage,
      getMetadataStrong: history.getGuildShareMetadataStrong,
      pointerExistsStrong: index.existsStrong,
      write: index.write,
    },
  );
  expect(result).toMatchObject({ written: 2, failed: 0 });
  const scan = commands.find((command) => command instanceof ScanCommand);
  expect(scan).toBeInstanceOf(ScanCommand);
  if (!(scan instanceof ScanCommand)) throw new Error("No scan");
  expect(
    Object.values(scan.input.ExpressionAttributeNames ?? {}).sort(),
  ).toEqual(
    [
      "accessGrants",
      "channelId_timestamp",
      "guildId",
      "meetingId",
      "ownerUserId",
      "ownershipScope",
      "timestamp",
    ].sort(),
  );
  expect(scan.input.Limit).toBe(100);
  const reads = commands.filter((command) => command instanceof GetItemCommand);
  expect(reads).toHaveLength(3);
  for (const read of reads) expect(read.input.ConsistentRead).toBe(true);
  const canonical = reads[0];
  expect(canonical.input.ProjectionExpression).toBe(
    scan.input.ProjectionExpression,
  );
  expect(canonical.input.ExpressionAttributeNames).toEqual(
    scan.input.ExpressionAttributeNames,
  );
  expect(commands[1]).toBeInstanceOf(GetItemCommand);
  const writes = commands.filter(
    (command) => command instanceof PutItemCommand,
  );
  expect(writes).toHaveLength(2);
  expect(writes[0].input.Item?.userId).toEqual({
    S: "GUILD_SHARE#synthetic-a",
  });
  expect(writes[0].input.Item?.userTimestamp).toEqual({
    S: "2026-10-01T00:00:00.000Z#personal:synthetic-owner#synthetic#2026",
  });
});

test("metadata inventory is one page even if filtered items are empty", async () => {
  const send = jest
    .spyOn(dynamoDbClient, "send")
    .mockImplementation(async () => ({
      Items: [],
      ScannedCount: 100,
      LastEvaluatedKey: { guildId: { S: "synthetic" } },
    }));
  expect(
    await inventoryGuildShareIndexMetadataPage({ limit: 100 }),
  ).toMatchObject({
    items: [],
    examined: 100,
    nextCursor: { guildId: { S: "synthetic" } },
  });
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    inventoryGuildShareIndexMetadataPage({ limit: 101 }),
  ).rejects.toThrow();
  await getGuildShareIndexMetadataStrong(metadata);
  const read = send.mock.calls[1][0];
  expect(read).toBeInstanceOf(GetItemCommand);
});

test("preserves continuation on an empty filtered inventory page", async () => {
  const cursor = {
    guildId: { S: "synthetic" },
    channelId_timestamp: { S: "page" },
  };
  const result = await repairMeetingShareIndexPage(
    { mode: "dry-run", limit: 100 },
    {
      inventory: jest
        .fn()
        .mockResolvedValue({ items: [], examined: 100, nextCursor: cursor }),
      getMetadataStrong: jest.fn(),
      pointerExistsStrong: jest.fn(),
      write: jest.fn(),
    },
  );
  expect(result).toEqual({
    nextCursor: cursor,
    examined: 100,
    personalWithGuildGrants: 0,
    missingPointers: 0,
    written: 0,
    skippedChanged: 0,
    failed: 0,
  });
});
