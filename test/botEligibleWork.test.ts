/** @jest-environment node */
import { ChannelType, Client, REST } from "discord.js";
import { setupBot, startEligibleBotWork } from "../src/bot";
import { getMeeting } from "../src/meetings";
import { config } from "../src/services/configService";
import { startMeetingControlCommandWorker } from "../src/services/meetingControlWorkerService";

const GUILD = "synthetic-eligible-guild";
jest.mock("../src/services/workerRegistry", () => ({ isEligible: () => true }));
jest.mock("../src/services/meetingControlWorkerService", () => ({
  startMeetingControlCommandWorker: jest.fn(),
}));
jest.mock("../src/meetings", () => ({
  getMeeting: jest.fn(() => undefined),
  initializeMeeting: jest.fn(),
}));
jest.mock("../src/db", () => ({}));

const captured: { client?: Client } = {};
beforeAll(async () => {
  jest.spyOn(Client.prototype, "login").mockImplementation(async function (
    this: Client,
  ) {
    captured.client = this;
    return "synthetic";
  });
  await setupBot();
});
afterAll(async () => {
  await captured.client?.destroy();
  jest.restoreAllMocks();
});

test("eligible bot work starts the control poller, registers commands and re-evaluates occupied voice channels", async () => {
  const client = captured.client!;
  // The retired /onboard command stays unregistered even with installer DMs on.
  config.server.onboardingEnabled = true;
  const put = jest.spyOn(REST.prototype, "put").mockResolvedValue([]);
  jest.spyOn(console, "log").mockImplementation(() => {});
  const state = {
    guild: { id: GUILD },
    channelId: "synthetic-voice",
    member: {
      id: "synthetic-user",
      user: { id: "synthetic-user", bot: false },
    },
  };
  Reflect.apply(Map.prototype.set, client.guilds.cache, [
    GUILD,
    { voiceStates: { cache: new Map([["synthetic-user", state]]) } },
  ]);

  startEligibleBotWork();
  for (
    let turn = 0;
    turn < 50 && !jest.mocked(getMeeting).mock.calls.length;
    turn += 1
  )
    await new Promise((resolve) => setImmediate(resolve));

  expect(startMeetingControlCommandWorker).toHaveBeenCalledWith(client);
  expect(put).toHaveBeenCalledTimes(1);
  expect(getMeeting).toHaveBeenCalledWith(GUILD);
  const { body } = put.mock.calls[0][1] as {
    body: { name: string; options?: unknown[] }[];
  };
  const names = body.map((command) => command.name);
  expect(names).not.toContain("onboard");
  expect(names).toEqual(
    expect.arrayContaining(["startmeeting", "context", "autorecord"]),
  );
  expect(body.find((command) => command.name === "startmeeting")).toEqual(
    expect.objectContaining({
      options: [
        expect.objectContaining({
          name: "context",
          required: false,
          max_length: 500,
        }),
        expect.objectContaining({
          name: "tags",
          required: false,
          max_length: 500,
        }),
        expect.objectContaining({
          name: "notes-channel",
          required: false,
          channel_types: [ChannelType.GuildText],
        }),
      ],
    }),
  );
});
