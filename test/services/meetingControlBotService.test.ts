/** @jest-environment node */
import { createMeetingStartDiscordFixture } from "../fixtures/meetingStart";
import { Message, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { interruptOwnedMeeting } from "../../src/services/ownedMeetingInterruption";
import { resolveServerMeetingArtifactAccess } from "../../src/services/meetingArtifactAccessService";
import { initializeMeeting } from "../../src/meetings";
import { getGlobalConfigValues } from "../../src/services/appConfigService";
import { executeMeetingControlCommand } from "../../src/services/meetingControlBotService";
import { checkBotPermissions } from "../../src/utils/permissions";
import {
  MEETING_CONTROL_COMMAND_TYPES,
  type MeetingControlCommand,
} from "../../src/types/meetingControl";

const fixture = createMeetingStartDiscordFixture();
let serverDestination: string | undefined;
let voiceDestination: string | undefined;
let fetchChannel: jest.SpyInstance;
let send: jest.SpyInstance;
const command = (textChannelId?: string): MeetingControlCommand => ({
  requestId: "request-1",
  commandType: MEETING_CONTROL_COMMAND_TYPES.START_MEETING,
  queueStatus: "pending",
  userId: fixture.creator.id,
  input: { serverId: fixture.guild.id, textChannelId },
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
  expiresAt: 1,
});

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  serverDestination = "server-notes";
  voiceDestination = "voice-notes";
  ({ fetchChannel, send } = fixture.resetStart({
    published: Reflect.construct(Message, [
      fixture.client,
      {
        id: "message-1",
        channel_id: fixture.notes.id,
        author: { id: fixture.bot.id, username: fixture.bot.username },
        timestamp: "2026-10-16T00:00:00Z",
      },
    ]),
    notesPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
    ],
    selectDestination: (scope) =>
      scope === "channel" ? voiceDestination : serverDestination,
  }));
});

test("omitted remote destination uses the current voice settings", async () => {
  const result = await executeMeetingControlCommand(fixture.client, command());
  expect(result).toEqual(
    expect.objectContaining({
      status: "started",
      textChannelId: "voice-notes",
    }),
  );
  expect(fetchChannel).toHaveBeenCalledWith("voice-notes");
  expect(initializeMeeting).toHaveBeenCalledWith(
    expect.objectContaining({
      textChannel: fixture.notes,
      startReason: "mcp",
      startTriggeredByUserId: fixture.creator.id,
    }),
  );
  expect(send).toHaveBeenCalledTimes(1);
});

test("an explicit remote destination keeps its existing validation and skips config", async () => {
  const result = await executeMeetingControlCommand(
    fixture.client,
    command("explicit-notes"),
  );
  expect(result).toEqual(expect.objectContaining({ status: "started" }));
  expect(fetchChannel).toHaveBeenCalledWith("explicit-notes");
  expect(getGlobalConfigValues).not.toHaveBeenCalled();
  expect(initializeMeeting).toHaveBeenCalled();
});

test("denied remote access does not initialize or disclose the hidden channel name", async () => {
  jest
    .spyOn(fixture.notes, "permissionsFor")
    .mockReturnValue(
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]),
    );
  const error = await executeMeetingControlCommand(
    fixture.client,
    command(),
  ).catch((failure: Error) => failure);
  expect(error).toBeInstanceOf(Error);
  if (!(error instanceof Error)) throw new Error("Expected access denial");
  expect(error.message).not.toContain("private-notes");
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("a bot permission denial prevents initialization", async () => {
  jest.mocked(checkBotPermissions).mockReturnValue({
    success: false,
    errorMessage: "Missing bot permissions.",
  });
  await expect(
    executeMeetingControlCommand(fixture.client, command()),
  ).rejects.toThrow("Missing bot permissions");
  expect(checkBotPermissions).toHaveBeenCalledWith(
    fixture.voice,
    fixture.notes,
    fixture.botMember,
  );
  expect(initializeMeeting).not.toHaveBeenCalled();
});

test("unconfigured remote start does not initialize", async () => {
  serverDestination = undefined;
  voiceDestination = undefined;
  await expect(
    executeMeetingControlCommand(fixture.client, command()),
  ).rejects.toThrow();
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(fetchChannel).not.toHaveBeenCalled();
});

test("a missing configured remote destination never initializes", async () => {
  fetchChannel.mockResolvedValue(null);
  await expect(
    executeMeetingControlCommand(fixture.client, command()),
  ).rejects.toThrow();
  expect(initializeMeeting).not.toHaveBeenCalled();
});

test("remote uncertain publication preserves once without retrying", async () => {
  send.mockRejectedValueOnce(new Error("Discord send response timed out"));
  await expect(
    executeMeetingControlCommand(fixture.client, command()),
  ).rejects.toThrow("timed out");
  const meeting = await jest.mocked(initializeMeeting).mock.results[0].value;
  expect(interruptOwnedMeeting).toHaveBeenCalledTimes(1);
  expect(interruptOwnedMeeting).toHaveBeenCalledWith(meeting, {
    reason: "processing_failure",
    deadline: expect.any(Number),
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(meeting.startMessageId).toBeUndefined();
});

test("remote ownership lost after initialization preserves before publication", async () => {
  let checks = 0;
  await expect(
    executeMeetingControlCommand(fixture.client, command(), async () => {
      if (++checks === 4) throw new Error("claim lost");
    }),
  ).rejects.toThrow("claim lost");
  expect(initializeMeeting).toHaveBeenCalledTimes(1);
  expect(interruptOwnedMeeting).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
});

test("remote artifact lookup failure never initializes", async () => {
  jest
    .mocked(resolveServerMeetingArtifactAccess)
    .mockRejectedValueOnce(new Error("lookup failed"));
  await expect(
    executeMeetingControlCommand(fixture.client, command()),
  ).rejects.toThrow("lookup failed");
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

const fixtureScope = {
  kind: "fixture" as const,
  reference: {
    holdId: "hold",
    introductionId: "intro",
    revision: 1,
    grantId: "fixture:11111111-1111-4111-8111-111111111111",
  },
  commandId: "fixture:11111111-1111-4111-8111-111111111111",
  meetingId: "preassigned-fixture",
  guildId: "guild-1",
  voiceChannelId: "voice-1",
  textChannelId: "voice-notes",
  actorUserId: "user-1",
  sessionMode: "meeting" as const,
};
const fixtureCommand = (): MeetingControlCommand => ({
  ...command("voice-notes"),
  requestId: "fixture:11111111-1111-4111-8111-111111111111",
  input: {
    serverId: "guild-1",
    voiceChannelId: "voice-1",
    textChannelId: "voice-notes",
  },
});
test("trusted remote fixture preserves its preassigned meeting and exact reservation scope", async () => {
  fetchChannel.mockReset();
  fetchChannel.mockImplementation(async (id: string) =>
    id === "voice-1" ? fixture.voice : fixture.notes,
  );
  await executeMeetingControlCommand(
    fixture.client,
    fixtureCommand(),
    undefined,
    undefined,
    fixtureScope,
  );
  expect(initializeMeeting).toHaveBeenCalledWith(
    expect.objectContaining({
      meetingId: "preassigned-fixture",
      scope: fixtureScope,
    }),
  );
});
test("a changed final notes destination refuses the fixture before initialization or publication", async () => {
  const changed = { ...fixtureScope, textChannelId: "previous-notes" };
  await expect(
    executeMeetingControlCommand(
      fixture.client,
      fixtureCommand(),
      undefined,
      undefined,
      changed,
    ),
  ).rejects.toThrow();
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
test("a copied fixture command refuses before initialization", async () => {
  await expect(
    executeMeetingControlCommand(
      fixture.client,
      { ...fixtureCommand(), requestId: "copied" },
      undefined,
      undefined,
      fixtureScope,
    ),
  ).rejects.toThrow();
  expect(initializeMeeting).not.toHaveBeenCalled();
});
