import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  getMeetingUserIndexRecordsForUserInRange,
  writeMeetingUserIndexRecords,
  getMeetingUserIndexTimestampPage,
  getMeetingHistoryTimestampPage,
} from "../src/db";
const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => send.mockReset());
afterAll(() => send.mockRestore());
test("reserved principal is rejected by raw-user reads and writes", async () => {
  await expect(
    getMeetingUserIndexRecordsForUserInRange("GUILD_SHARE#g", "2020", "2030"),
  ).rejects.toThrow(/reserved/i);
  await expect(
    writeMeetingUserIndexRecords([
      {
        userId: "GUILD_SHARE#g",
        userTimestamp: "t",
        guildId: "g",
        channelId_timestamp: "c",
        meetingId: "m",
        timestamp: "t",
        accessReason: "owner",
      },
    ]),
  ).rejects.toThrow(/reserved/i);
  expect(send).not.toHaveBeenCalled();
});
test("principal page preserves an empty page continuation with one bounded query", async () => {
  const cursor = marshall({
    userId: "GUILD_SHARE#g",
    userTimestamp: "2026#g#c",
  });
  send.mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor } as never);
  const signal = new AbortController().signal;
  await expect(
    getMeetingUserIndexTimestampPage("GUILD_SHARE#g", {
      startTimestamp: "2020",
      endTimestamp: "2030",
      limit: 2,
      signal,
    }),
  ).resolves.toEqual({ items: [], nextCursor: cursor });
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].input).toMatchObject({ Limit: 2 });
  expect(send.mock.calls[0][1]).toEqual({ abortSignal: signal });
});
test("history page checkpoints retain equal timestamp identity and cancelled candidates", async () => {
  const record = {
    guildId: "g",
    timestamp: "2026",
    channelId_timestamp: "c1",
    status: "cancelled",
  };
  const checkpoint = marshall({
    guildId: "g",
    timestamp: "2026",
    channelId_timestamp: "c1",
  });
  send.mockResolvedValueOnce({
    Items: [marshall(record)],
    LastEvaluatedKey: checkpoint,
  } as never);
  const page = await getMeetingHistoryTimestampPage("g", {
    startTimestamp: "2020",
    endTimestamp: "2030",
    limit: 2,
  });
  expect(page.items).toEqual([{ record, cursorAfter: checkpoint }]);
  send.mockResolvedValueOnce({
    Items: [marshall({ ...record, channelId_timestamp: "c2" })],
  } as never);
  const next = await getMeetingHistoryTimestampPage("g", {
    startTimestamp: "2020",
    endTimestamp: "2030",
    limit: 2,
    cursor: page.items[0].cursorAfter,
  });
  expect(send.mock.calls[1][0].input).toMatchObject({
    ExclusiveStartKey: checkpoint,
    Limit: 2,
  });
  expect(next.items[0].record.channelId_timestamp).toBe("c2");
});

test("mock pages resume equal timestamps after a consumed prefix", async () => {
  const { config } = await import("../src/services/configService");
  const { getMockStore } = await import("../src/repositories/mockStore");
  const { getMeetingHistoryRepository } =
    await import("../src/repositories/meetingHistoryRepository");
  const { getMeetingUserIndexRepository } =
    await import("../src/repositories/meetingUserIndexRepository");
  const previous = config.mock.enabled;
  config.mock.enabled = true;
  const store = getMockStore();
  const saved = store.meetingHistoryByGuild.get("page-test");
  try {
    const base = {
      guildId: "page-test",
      channelId: "c",
      meetingId: "m",
      timestamp: "2026",
      participants: [{ id: "fixture-user", username: "fixture-user" }],
      duration: 1,
      transcribeMeeting: true,
      generateNotes: true,
    };
    store.meetingHistoryByGuild.set("page-test", [
      { ...base, channelId_timestamp: "c2" },
      { ...base, channelId_timestamp: "c1" },
    ]);
    const options = { startTimestamp: "2020", endTimestamp: "2030", limit: 2 };
    const history = getMeetingHistoryRepository();
    const first = await history.listByGuildTimestampPage("page-test", options);
    const second = await history.listByGuildTimestampPage("page-test", {
      ...options,
      cursor: first.items[0].cursorAfter,
    });
    expect(second.items.map((item) => item.record.channelId_timestamp)).toEqual(
      ["c1"],
    );
    const index = getMeetingUserIndexRepository();
    const pointers = await index.listByPrincipalTimestampPage("fixture-user", {
      ...options,
      limit: 1,
    });
    expect(pointers.nextCursor).toEqual(pointers.items[0].cursorAfter);
    const tail = await index.listByPrincipalTimestampPage("fixture-user", {
      ...options,
      cursor: pointers.nextCursor,
    });
    expect(tail.items.map((item) => item.record.channelId_timestamp)).toEqual([
      "c1",
    ]);
  } finally {
    config.mock.enabled = previous;
    if (saved) store.meetingHistoryByGuild.set("page-test", saved);
    else store.meetingHistoryByGuild.delete("page-test");
  }
});
