import type { Request, Response } from "express";
import { autorecordRouter } from "../../src/trpc/routers/autorecord";
import { channelContextsRouter } from "../../src/trpc/routers/channelContexts";
import {
  getMockStore,
  getMockUser,
  resetMockStore,
} from "../../src/repositories/mockStore";
import {
  ensureManageGuildWithUserToken,
  ensureBotInGuild,
} from "../../src/services/guildAccessService";
import {
  fetchChannelContext,
  setChannelContext,
} from "../../src/services/channelContextService";

jest.mock("../../src/services/guildAccessService", () => ({
  ensureManageGuildWithUserToken: jest.fn(),
  ensureBotInGuild: jest.fn(),
}));
const context = () => ({
  req: { session: {} } as Request,
  res: {} as Response,
  user: getMockUser(),
});
const input = {
  serverId: "routing-guild",
  mode: "one",
  voiceChannelId: "voice",
} as const;
beforeEach(async () => {
  jest.clearAllMocks();
  resetMockStore();
  getMockStore().configOverrides.clear();
  jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(true);
  jest.mocked(ensureBotInGuild).mockResolvedValue(true);
  await setChannelContext("routing-guild", "voice", "admin", {
    defaultNotesChannelId: "notes",
  });
});
test.each([
  { destination: undefined, expected: "notes" },
  { destination: "replacement", expected: "replacement" },
  { destination: null, expected: undefined },
])(
  "persists destination omission, replacement and reset: $destination",
  async ({ destination, expected }) => {
    await autorecordRouter
      .createCaller(context())
      .add({ ...input, textChannelId: destination });
    expect(
      (await fetchChannelContext("routing-guild", "voice"))
        ?.defaultNotesChannelId,
    ).toBe(expected);
  },
);
test("disable retains routing and whole-settings deletion removes it", async () => {
  const caller = autorecordRouter.createCaller(context());
  await caller.add(input);
  await caller.remove({ serverId: "routing-guild", channelId: "voice" });
  expect(
    (await fetchChannelContext("routing-guild", "voice"))
      ?.defaultNotesChannelId,
  ).toBe("notes");
  await channelContextsRouter
    .createCaller(context())
    .clear({ serverId: "routing-guild", channelId: "voice" });
  expect(await fetchChannelContext("routing-guild", "voice")).toBeUndefined();
});
test("saved routing and recording writes require Manage Server", async () => {
  jest.mocked(ensureManageGuildWithUserToken).mockResolvedValue(false);
  const caller = autorecordRouter.createCaller(context());
  await expect(caller.add(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    caller.remove({ serverId: "routing-guild", channelId: "voice" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    channelContextsRouter.createCaller(context()).set({
      serverId: "routing-guild",
      channelId: "voice",
      defaultNotesChannelId: "replacement",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    (await fetchChannelContext("routing-guild", "voice"))
      ?.defaultNotesChannelId,
  ).toBe("notes");
});
