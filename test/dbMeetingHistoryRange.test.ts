import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { getMeetingsForGuildInRange } from "../src/db";
import { listAllMeetingsForGuildService } from "../src/services/meetingHistoryService";
import { config } from "../src/services/configService";

const send = jest.spyOn(DynamoDBClient.prototype, "send");
beforeEach(() => send.mockReset());
afterAll(() => send.mockRestore());

test("history pagination passes the deadline to the SDK and stops after a late page", async () => {
  const controller = new AbortController();
  send.mockImplementationOnce(async () => {
    controller.abort();
    return {
      Items: [],
      LastEvaluatedKey: marshall({ guildId: "guild-1" }),
    } as never;
  });
  const mockEnabled = config.mock.enabled;
  config.mock.enabled = false;
  try {
    await expect(
      listAllMeetingsForGuildService("guild-1", controller.signal),
    ).rejects.toThrow();
  } finally {
    config.mock.enabled = mockEnabled;
  }
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
});

test("an expired deadline starts no history query", async () => {
  await expect(
    getMeetingsForGuildInRange(
      "guild-1",
      "2020",
      "2030",
      undefined,
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});

test("ordinary callers still receive every history page", async () => {
  send.mockResolvedValueOnce({
    Items: [marshall({ meetingId: "first" })],
    LastEvaluatedKey: marshall({ guildId: "guild-1" }),
  } as never);
  send.mockResolvedValueOnce({
    Items: [marshall({ meetingId: "second" })],
  } as never);
  await expect(
    getMeetingsForGuildInRange("guild-1", "2020", "2030"),
  ).resolves.toEqual([{ meetingId: "first" }, { meetingId: "second" }]);
  expect(send).toHaveBeenCalledTimes(2);
});
