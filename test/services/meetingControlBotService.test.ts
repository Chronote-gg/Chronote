/** @jest-environment node */
import { createMeetingStartDiscordFixture } from "../fixtures/meetingStart";
import { Message, PermissionFlagsBits, PermissionsBitField } from "discord.js";
import { closeMeeting } from "../../src/services/meetingClose";
import { resolveServerMeetingArtifactAccess } from "../../src/services/meetingArtifactAccessService";
import { getMeeting, initializeMeeting } from "../../src/meetings";
import { getActiveMeetingLeaseForGuild } from "../../src/services/meetingLease";
import {
  persistExplicitMeetingStop,
  runEndMeetingFlow,
} from "../../src/commands/endMeeting";
import { stopMcpMeetingControl } from "../../src/services/mcpMeetingControlService";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import { getMeetingControlCommandRepository } from "../../src/repositories/meetingControlCommandRepository";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import type { ActiveMeetingLease } from "../../src/types/db";
import type { MeetingData } from "../../src/types/meeting-data";
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
  expect(closeMeeting).toHaveBeenCalledTimes(1);
  expect(closeMeeting).toHaveBeenCalledWith(meeting, {
    endReason: "unknown",
    abnormal: true,
  });
  expect(send).toHaveBeenCalledTimes(1);
  expect(meeting.startMessageId).toBeUndefined();
});

test("remote ownership lost after initialization preserves before publication", async () => {
  let checks = 0;
  await expect(
    executeMeetingControlCommand(fixture.client, command(), async () => {
      if (++checks === 3) throw new Error("claim lost");
    }),
  ).rejects.toThrow("claim lost");
  expect(initializeMeeting).toHaveBeenCalledTimes(1);
  expect(closeMeeting).toHaveBeenCalledTimes(1);
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

const LEASE_SECONDS = 600;
const liveLease = (meetingId: string) =>
  ({
    guildId: fixture.guild.id,
    meetingId,
    ownerInstanceId: getRuntimeInstanceId(),
    leaseExpiresAt: Math.floor(Date.now() / 1000) + LEASE_SECONDS,
    voiceChannelId: fixture.voice.id,
    textChannelId: fixture.notes.id,
  }) as ActiveMeetingLease;

test("a stop enqueued without a meeting id is pinned to the live meeting and does not stop a newer meeting", async () => {
  jest
    .mocked(getActiveMeetingLeaseForGuild)
    .mockResolvedValue(liveLease("synthetic-live-meeting"));
  const queued = stopMcpMeetingControl({
    userId: fixture.creator.id,
    request: { serverId: fixture.guild.id },
  });
  const repository = getMeetingControlCommandRepository();
  const listPending = () =>
    repository.listClaimablePendingCommands({
      instanceId: getRuntimeInstanceId(),
      nowEpochSeconds: Math.floor(Date.now() / 1000),
      limit: 1,
    });
  let pending = await listPending();
  while (pending.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
    pending = await listPending();
  }
  expect(pending[0].input).toMatchObject({
    meetingId: "synthetic-live-meeting",
  });
  const newer = {
    meetingId: "synthetic-newer-meeting",
    creator: fixture.creator,
    onEndMeeting: jest.fn(),
  } as unknown as MeetingData;
  jest.mocked(getMeeting).mockReturnValue(newer);
  jest
    .mocked(getActiveMeetingLeaseForGuild)
    .mockResolvedValue(liveLease("synthetic-newer-meeting"));
  await processMeetingControlCommand(fixture.client, pending[0]);
  await expect(queued).resolves.toMatchObject({
    queueStatus: "failed",
    error: "Meeting not found.",
  });
  expect(newer.onEndMeeting).not.toHaveBeenCalled();
  expect(closeMeeting).not.toHaveBeenCalled();
  expect(persistExplicitMeetingStop).not.toHaveBeenCalled();
});

test("a control-queue stop of the local meeting shows processing through the end flow, after one suppression", async () => {
  const order: string[] = [];
  const meeting = {
    meetingId: "synthetic-live-meeting",
    creator: fixture.creator,
    finishing: false,
    finished: false,
  } as unknown as MeetingData;
  jest.mocked(getMeeting).mockReturnValue(meeting);
  jest.mocked(persistExplicitMeetingStop).mockImplementation(async () => {
    order.push("suppress");
  });
  jest.mocked(runEndMeetingFlow).mockImplementation(async () => {
    order.push("end-flow");
  });

  const result = await executeMeetingControlCommand(fixture.client, {
    ...command(),
    commandType: MEETING_CONTROL_COMMAND_TYPES.STOP_MEETING,
    input: { serverId: fixture.guild.id, meetingId: meeting.meetingId },
  });

  expect(result).toMatchObject({ status: "ended" });
  expect(order).toEqual(["suppress", "end-flow"]);
  expect(persistExplicitMeetingStop).toHaveBeenCalledTimes(1);
  expect(runEndMeetingFlow).toHaveBeenCalledWith({
    meeting,
    suppressionPersisted: true,
  });
  expect(meeting).toMatchObject({
    endReason: "mcp",
    endTriggeredByUserId: fixture.creator.id,
  });
  expect(closeMeeting).not.toHaveBeenCalled();
});
