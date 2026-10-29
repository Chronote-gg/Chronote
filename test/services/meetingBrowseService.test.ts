/** @jest-environment node */
import type { MeetingHistory } from "../../src/types/db";
import type { MeetingBrowseFilters } from "../../src/types/meetingBrowse";
import { listMcpMyMeetings } from "../../src/services/mcpMeetingService";
import { getMockStore } from "../../src/repositories/mockStore";
import { getMeetingHistoryRepository } from "../../src/repositories/meetingHistoryRepository";
import { getMeetingUserIndexRepository } from "../../src/repositories/meetingUserIndexRepository";
import {
  getGuildMemberCached,
  listBotGuildsCached,
} from "../../src/services/discordCacheService";
import { ensureUserCanConnectChannel } from "../../src/services/discordPermissionsService";
import { resolveAttendeeAccessEnabled } from "../../src/services/attendeeAccessSetting";
import { DiscordApiError } from "../../src/services/discordService";

jest.mock("../../src/services/discordCacheService", () => ({
  getGuildMemberCached: jest.fn(async () => ({ roles: [] })),
  listBotGuildsCached: jest.fn(async () => [{ id: "guild", name: "Guild" }]),
  listGuildChannelsCached: jest.fn(async () => []),
  listGuildRolesCached: jest.fn(async () => []),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(async () => true),
  ensureUserCanReadChannelHistory: jest.fn(async () => true),
}));
jest.mock("../../src/services/attendeeAccessSetting", () => ({
  resolveAttendeeAccessEnabled: jest.fn(async () => true),
}));
jest.mock("../../src/services/meetingArtifactAccessService", () => ({
  resolveServerMeetingArtifactAccess: jest.fn(async () => ({
    transcriptAccessEnabled: false,
    audioAccessEnabled: false,
  })),
  resolveMeetingArtifactAccess: jest.fn(async () => ({
    transcriptAccessEnabled: false,
    audioAccessEnabled: false,
  })),
}));
const browse: MeetingBrowseFilters = {
  scope: { kind: "all" },
  attendedOnly: false,
};
const row = (
  id: string,
  overrides: Partial<MeetingHistory> = {},
): MeetingHistory => ({
  guildId: "guild",
  channelId_timestamp: `${id}#2026-01-01T00:00:00.000Z`,
  channelId: id,
  timestamp: "2026-01-01T00:00:00.000Z",
  meetingId: id,
  duration: 10,
  transcribeMeeting: true,
  generateNotes: true,
  meetingName: `title-${id}`,
  summarySentence: `summary-${id}`,
  transcriptS3Key: "secret",
  audioS3Key: "secret",
  ...overrides,
});
const save = (...rows: MeetingHistory[]) => {
  for (const meeting of rows) {
    const existing =
      getMockStore().meetingHistoryByGuild.get(meeting.guildId) ?? [];
    existing.push(meeting);
    getMockStore().meetingHistoryByGuild.set(meeting.guildId, existing);
  }
};
const list = (extra: Partial<Parameters<typeof listMcpMyMeetings>[0]> = {}) =>
  listMcpMyMeetings({
    userId: "123",
    mode: "accessible",
    range: "all",
    limit: 25,
    browse,
    ...extra,
  });
beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  getMockStore().meetingHistoryByGuild.clear();
  jest
    .mocked(listBotGuildsCached)
    .mockResolvedValue([{ id: "guild", name: "Guild" }]);
  jest.mocked(getGuildMemberCached).mockResolvedValue({ roles: [] });
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(true);
  jest.mocked(resolveAttendeeAccessEnabled).mockResolvedValue(true);
});

test("continues beyond 1,001 denied candidates without false exhaustion", async () => {
  const read = jest.spyOn(
    getMeetingHistoryRepository(),
    "listByGuildTimestampPage",
  );
  const get = jest.spyOn(getMeetingHistoryRepository(), "get");
  save(
    ...Array.from({ length: 1001 }, (_, i) =>
      row(`denied-${i}`, {
        timestamp: new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(),
      }),
    ),
    row("allowed-older"),
  );
  jest
    .mocked(ensureUserCanConnectChannel)
    .mockImplementation(async ({ channelId }) => channelId === "allowed-older");
  const first = await list();
  expect(first.meetings).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  expect(first.discoveryComplete).toBe(false);
  expect(get).toHaveBeenCalledTimes(1000);
  expect(read.mock.calls.length).toBeLessThanOrEqual(11);
  expect(read.mock.calls.every(([, options]) => options.limit === 100)).toBe(
    true,
  );
  const second = await list({ cursor: first.nextCursor! });
  expect(second.meetings.map((item) => item.meetingId)).toEqual([
    "allowed-older",
  ]);
  expect(second.discoveryComplete).toBe(true);
});
test("sorts timestamp ties across storage pages without losing unused tails or duplicates", async () => {
  save(
    ...Array.from({ length: 205 }, (_, i) =>
      row(`item-${String(i).padStart(3, "0")}`, {
        participants: [{ id: "123", username: "actor" }],
      }),
    ),
  );
  const ids: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 12; page++) {
    const result = await list({ limit: 25, cursor });
    ids.push(...result.meetings.map((item) => item.meetingId));
    cursor = result.nextCursor ?? undefined;
    if (!cursor) break;
  }
  expect(ids).toHaveLength(205);
  expect(new Set(ids).size).toBe(205);
  expect(ids[0]).toBe("item-204");
  expect(ids.at(-1)).toBe("item-000");
});
test("finishes oversized tie comparison before emitting and rescans lower ranks after the best page", async () => {
  save(
    ...Array.from({ length: 1100 }, (_, i) =>
      row(`item-${String(i).padStart(4, "0")}`),
    ),
  );
  const first = await list({ limit: 2 });
  expect(first.meetings).toEqual([]);
  expect(first.discoveryComplete).toBe(false);
  const second = await list({ limit: 2, cursor: first.nextCursor! });
  expect(second.meetings.map((item) => item.meetingId)).toEqual([
    "item-1099",
    "item-1098",
  ]);
  const third = await list({ limit: 2, cursor: second.nextCursor! });
  const fourth = await list({ limit: 2, cursor: third.nextCursor! });
  expect(fourth.meetings.map((item) => item.meetingId)).toEqual([
    "item-1097",
    "item-1096",
  ]);
});
test("reauthorizes a buffered result after revocation and permits immutable retry", async () => {
  save(
    ...Array.from({ length: 1100 }, (_, i) =>
      row(`item-${String(i).padStart(4, "0")}`),
    ),
  );
  const first = await list({ limit: 2 });
  jest
    .mocked(ensureUserCanConnectChannel)
    .mockImplementation(async ({ channelId }) => channelId !== "item-1099");
  const second = await list({ limit: 2, cursor: first.nextCursor! });
  const retry = await list({ limit: 2, cursor: first.nextCursor! });
  expect(second.meetings.map((item) => item.meetingId)).toEqual([
    "item-1098",
    "item-1097",
  ]);
  expect(retry.meetings).toEqual(second.meetings);
});
test("rebuilds a truncated tie when multiple buffered grants are revoked", async () => {
  save(
    ...Array.from({ length: 1100 }, (_, i) =>
      row(`item-${String(i).padStart(4, "0")}`),
    ),
  );
  const first = await list({ limit: 2 });
  jest
    .mocked(ensureUserCanConnectChannel)
    .mockImplementation(
      async ({ channelId }) =>
        !["item-1099", "item-1098", "item-1097"].includes(channelId),
    );
  const ids: string[] = [];
  let cursor = first.nextCursor;
  for (let i = 0; i < 4 && !ids.length && cursor; i++) {
    const page = await list({ limit: 2, cursor });
    ids.push(...page.meetings.map((item) => item.meetingId));
    cursor = page.nextCursor;
  }
  expect(ids).toEqual(["item-1096", "item-1095"]);
});
test("keeps v1 cursors for legacy callers but rejects them as portal browse state", async () => {
  save(row("one", { timestamp: "2026-01-02T00:00:00.000Z" }), row("two"));
  const cursor = Buffer.from(
    JSON.stringify({
      timestamp: "2026-01-02T00:00:00.000Z",
      identity: "guild#one#2026-01-01T00:00:00.000Z",
      startDate: "1970-01-01T00:00:00.000Z",
      endDate: "2026-10-29T00:00:00.000Z",
      mode: "accessible",
    }),
  ).toString("base64url");
  expect(
    (await listMcpMyMeetings({ userId: "123", cursor })).meetings.map(
      (item) => item.meetingId,
    ),
  ).toEqual(["two"]);
  await expect(list({ cursor })).rejects.toThrow(/cursor/i);
});
test("restricted legacy tokens never gain attendee bypass or out-of-scope access", async () => {
  save(
    row("private", { participants: [{ id: "123", username: "actor" }] }),
    row("other"),
  );
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(false);
  expect(
    (
      await listMcpMyMeetings({
        userId: "123",
        range: "all",
        restriction: { guildId: "guild", channelIds: ["private"] },
      })
    ).meetings,
  ).toEqual([]);
});
test("does not turn source errors or unknown permission decisions into an empty library", async () => {
  save(row("one"));
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(null);
  await expect(list()).rejects.toThrow();
  jest
    .spyOn(getMeetingHistoryRepository(), "listByGuildTimestampPage")
    .mockRejectedValue(new Error("source unavailable"));
  await expect(list()).rejects.toThrow("source unavailable");
});
test("fails explicitly when guild membership discovery is unknown", async () => {
  jest
    .mocked(getGuildMemberCached)
    .mockRejectedValue(new Error("Discord unavailable"));
  await expect(list({ userId: "unknown-membership" })).rejects.toThrow();
});
test("advances empty intermediate storage pages", async () => {
  save(row("one"));
  const repository = getMeetingHistoryRepository();
  const original = repository.listByGuildTimestampPage;
  jest
    .spyOn(repository, "listByGuildTimestampPage")
    .mockImplementationOnce(async () => ({
      items: [],
      nextCursor: { marker: { S: "empty" } },
    }))
    .mockImplementation(original);
  expect((await list()).meetings.map((item) => item.meetingId)).toEqual([
    "one",
  ]);
});
test("personal discovery uses canonical current grants and excludes personal rows from a server source", async () => {
  save(
    row("shared", {
      guildId: "personal:owner",
      ownerUserId: "owner",
      accessGrants: [{ targetType: "guild", guildId: "guild" }],
    }),
    row("owned", { guildId: "personal:123", ownerUserId: "123" }),
  );
  expect(
    (
      await list({ browse: { ...browse, scope: { kind: "personal" } } })
    ).meetings
      .map((item) => item.meetingId)
      .sort(),
  ).toEqual(["owned", "shared"]);
  expect(
    (
      await list({
        browse: { ...browse, scope: { kind: "guild", serverId: "guild" } },
      })
    ).meetings,
  ).toEqual([]);
});
test("retains former-member attendance, but ownership of a real guild row does not bypass membership", async () => {
  jest.mocked(listBotGuildsCached).mockResolvedValue([]);
  jest
    .mocked(getGuildMemberCached)
    .mockRejectedValue(new DiscordApiError(404, "not member"));
  save(
    row("attended", { participants: [{ id: "123", username: "actor" }] }),
    row("creator", { meetingCreatorId: "123" }),
  );
  const result = await list({
    browse: { ...browse, scope: { kind: "guild", serverId: "guild" } },
  });
  expect(result.meetings.map((item) => item.meetingId)).toEqual(["attended"]);
  jest.mocked(resolveAttendeeAccessEnabled).mockResolvedValue(false);
  expect((await list()).meetings).toEqual([]);
});
test("attendance intersection only accepts participants and legacy attendee mentions", async () => {
  save(
    row("participant", { participants: [{ id: "123", username: "actor" }] }),
    row("legacy", { attendees: ["<@123>"] }),
    row("creator", { meetingCreatorId: "123" }),
    row("trigger", { startTriggeredByUserId: "123" }),
    row("owned", { guildId: "personal:123", ownerUserId: "123" }),
    row("shared", {
      guildId: "personal:other",
      accessGrants: [{ targetType: "user", userId: "123" }],
    }),
  );
  const result = await list({ browse: { ...browse, attendedOnly: true } });
  expect(result.meetings.map((item) => item.meetingId).sort()).toEqual([
    "legacy",
    "participant",
  ]);
});
test("stale, revoked and deleted index pointers cannot expose fields", async () => {
  const personal = row("revoked", {
    guildId: "personal:other",
    ownerUserId: "other",
  });
  save(personal);
  jest
    .spyOn(getMeetingUserIndexRepository(), "listByPrincipalTimestampPage")
    .mockResolvedValue({
      items: [personal, row("deleted", { guildId: "personal:other" })].map(
        (record) => ({
          record: {
            ...record,
            userId: "123",
            userTimestamp: record.channelId_timestamp,
          },
          cursorAfter: { userTimestamp: { S: record.channelId_timestamp } },
        }),
      ),
    });
  const result = await list();
  expect(result.meetings).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("title-revoked");
  expect(JSON.stringify(result)).not.toContain("secret");
});
test("accessible non-attended rows keep artifact-off flags and bind every filter", async () => {
  save(row("one"), row("two"));
  const first = await list({ limit: 1 });
  expect(first.meetings[0]).toMatchObject({
    transcriptAvailable: false,
    audioAvailable: false,
  });
  await expect(
    list({ limit: 1, cursor: first.nextCursor!, tags: ["changed"] }),
  ).rejects.toThrow(/cursor/i);
  await expect(
    list({ limit: 1, cursor: first.nextCursor!, userId: "other" }),
  ).rejects.toThrow(/cursor/i);
});
