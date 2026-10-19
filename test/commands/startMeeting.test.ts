/** @jest-environment node */
import { createMeetingStartDiscordFixture } from "../fixtures/meetingStart";
import { createUpgradeRecordingLimitNotice } from "../fixtures/recordingLimitNotice";
import {
  ChannelType,
  ChatInputCommandInteraction,
  UserContextMenuCommandInteraction,
  InteractionResponse,
  ActionRowBuilder,
  Message,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import {
  updateMeetingProcessingMessage,
  updateMeetingSummaryMessage,
} from "../../src/embed";
import { getRollingUsageForGuild } from "../../src/services/meetingUsageService";
import {
  encounterRecordingLimit,
  deliverRecordingLimitNotice,
} from "../../src/services/recordingLimitService";
import { deleteMeeting, initializeMeeting } from "../../src/meetings";
import { listConfigOverridesForScope } from "../../src/services/configOverridesService";
import { handleRequestStartMeeting } from "../../src/commands/startMeeting";
import { interruptOwnedMeeting } from "../../src/services/ownedMeetingInterruption";
import { resolveMeetingVoiceSettings } from "../../src/services/meetingVoiceSettingsService";
import { resolveServerMeetingArtifactAccess } from "../../src/services/meetingArtifactAccessService";
import { getActiveMeetingLeaseForGuild } from "../../src/services/activeMeetingLeaseService";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { checkBotPermissions } from "../../src/utils/permissions";
import type { MeetingData } from "../../src/types/meeting-data";

const { client, guild, creator, bot, botMember, voice, notes, resetStart } =
  createMeetingStartDiscordFixture();
let serverDestination: string | undefined;
let voiceDestination: string | undefined;
let fetchChannel: jest.SpyInstance;
let send: jest.SpyInstance;
jest.mock("../../src/services/meetingUsageService", () => ({
  getRollingUsageForGuild: jest.fn(),
  getRollingWindowMs: jest.fn(() => 7 * 86400000),
  getNextAvailableAt: jest.fn(() => "2026-10-20T00:00:00Z"),
}));
jest.mock("../../src/services/summaryUpgradeService", () => ({
  claimSummaryUpgrade: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/recordingLimitService", () => ({
  encounterRecordingLimit: jest.fn(),
  deliverRecordingLimitNotice: jest.fn(async (notice, deliver) => deliver()),
}));
const invocation: TextChannel = Reflect.construct(TextChannel, [
  guild,
  { id: "invocation", type: ChannelType.GuildText, name: "general" },
  client,
]);
const published: Message<true> = Reflect.construct(Message, [
  client,
  {
    id: "published",
    channel_id: notes.id,
    guild_id: guild.id,
    author: { id: bot.id, username: bot.username },
    timestamp: "2026-10-16T00:00:00Z",
  },
]);
let warning: jest.SpyInstance;
function interaction(
  contextMenu = false,
  explicitChannelId?: string,
  channelId = invocation.id,
) {
  const data = {
    id: "interaction",
    application_id: bot.id,
    token: "fake",
    type: 2,
    entitlements: [],
    authorizing_integration_owners: {},
    guild_id: guild.id,
    channel: { id: channelId },
    user: { id: creator.id, username: creator.username },
    data: {
      id: "command",
      name: contextMenu ? "Start meeting" : "startmeeting",
      type: contextMenu ? 2 : 1,
      target_id: creator.id,
      resolved: {
        channels: { [notes.id]: { id: notes.id, type: 0, name: notes.name } },
        users: { [creator.id]: { id: creator.id, username: creator.username } },
      },
      options: explicitChannelId
        ? [{ name: "notes-channel", type: 7, value: explicitChannelId }]
        : [],
    },
  };
  const request:
    ChatInputCommandInteraction | UserContextMenuCommandInteraction =
    Reflect.construct(
      contextMenu
        ? UserContextMenuCommandInteraction
        : ChatInputCommandInteraction,
      [client, data],
    );
  jest.spyOn(request, "deferReply").mockImplementation(async () => {
    request.deferred = true;
    return Reflect.construct(InteractionResponse, [request]);
  });
  jest
    .spyOn(request, "reply")
    .mockResolvedValue(Reflect.construct(InteractionResponse, [request]));
  jest.spyOn(request, "editReply").mockResolvedValue(published);
  return request;
}
async function currentMeeting(): Promise<MeetingData> {
  return jest.mocked(initializeMeeting).mock.results[0].value;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.mocked(getActiveMeetingLeaseForGuild).mockResolvedValue(undefined);
  serverDestination = "server-notes";
  voiceDestination = "voice-notes";
  ({ fetchChannel, send } = resetStart({
    published,
    notesPermissions: [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.ReadMessageHistory,
    ],
    selectDestination: (scope) =>
      scope === "channel" ? voiceDestination : serverDestination,
  }));
  for (const channel of [voice, notes, invocation]) {
    client.channels.cache.set(channel.id, channel);
    guild.channels.cache.set(channel.id, channel);
  }
  jest.spyOn(invocation, "send").mockResolvedValue(published);
  jest
    .spyOn(invocation, "permissionsFor")
    .mockReturnValue(
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]),
    );
});

afterEach(() => warning.mockRestore());

test.each([false, true])(
  "private_reply_in_same_and_different_channels (same=%s)",
  async (same) => {
    const request = interaction(
      false,
      undefined,
      same ? notes.id : invocation.id,
    );
    await handleRequestStartMeeting(request);
    expect(request.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(invocation.send).not.toHaveBeenCalled();
    expect(request.reply).not.toHaveBeenCalled();
    expect((await currentMeeting()).startMessageId).toBe(published.id);
  },
);

test.each([false, true])(
  "slash_and_context_menu_share_defaults (context=%s)",
  async (context) => {
    const request = interaction(context);
    if (context) request.deferred = true;
    await handleRequestStartMeeting(
      request,
      context ? { deferredEphemeralReply: true } : undefined,
    );
    expect(fetchChannel).toHaveBeenCalledWith("voice-notes");
    expect(initializeMeeting).toHaveBeenCalledWith(
      expect.objectContaining({ textChannel: notes }),
    );
    expect(request.deferReply).toHaveBeenCalledTimes(context ? 0 : 1);
  },
);

test("acknowledgment_links_to_published_message", async () => {
  const request = interaction();
  await handleRequestStartMeeting(request);
  const acknowledgment = jest.mocked(request.editReply).mock.calls[0][0];
  expect(acknowledgment).toEqual(
    expect.objectContaining({
      content: expect.stringContaining("Voice"),
      allowedMentions: { parse: [] },
    }),
  );
  if (typeof acknowledgment === "string" || !acknowledgment.components)
    throw new Error("Missing acknowledgment components");
  expect(acknowledgment.content).toContain(`<#${notes.id}>`);
  const row = acknowledgment.components[0];
  expect(row).toBeInstanceOf(ActionRowBuilder);
  if (!(row instanceof ActionRowBuilder))
    throw new Error("Expected action row");
  expect(row.toJSON().components[0]).toEqual(
    expect.objectContaining({ label: "View recording", url: published.url }),
  );
});

test("an explicit destination skips configured defaults", async () => {
  await handleRequestStartMeeting(interaction(false, notes.id));
  expect(fetchChannel).toHaveBeenCalledWith(notes.id);
  expect(listConfigOverridesForScope).not.toHaveBeenCalled();
});

test("publication_failure_preserves_owned_capture", async () => {
  send.mockRejectedValueOnce(
    new Error("Discord accepted send but response timed out"),
  );
  const request = interaction();
  await handleRequestStartMeeting(request);
  const meeting = await currentMeeting();
  expect(interruptOwnedMeeting).toHaveBeenCalledWith(meeting, {
    reason: "processing_failure",
    deadline: expect.any(Number),
  });
  expect(meeting.startMessageId).toBeUndefined();
  expect(deleteMeeting).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledTimes(1);
  expect(request.editReply).toHaveBeenCalledWith(
    expect.stringContaining("could not be confirmed"),
  );
  expect(request.editReply).not.toHaveBeenCalledWith(
    expect.objectContaining({ components: expect.anything() }),
  );
});

test("ack_failure_keeps_published_recording", async () => {
  const request = interaction();
  jest
    .mocked(request.editReply)
    .mockRejectedValueOnce(new Error("expired interaction"));
  await handleRequestStartMeeting(request);
  expect(interruptOwnedMeeting).not.toHaveBeenCalled();
  expect((await currentMeeting()).startMessageId).toBe(published.id);
  expect(send).toHaveBeenCalledTimes(1);
  expect(request.editReply).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    "Failed to acknowledge meeting start",
    expect.objectContaining({ meetingId: "meeting-1" }),
  );
});

test("running_destination_is_frozen", async () => {
  await handleRequestStartMeeting(interaction());
  voiceDestination = "different-notes";
  serverDestination = "other-default";
  const meeting = await currentMeeting();
  expect(meeting.textChannel).toBe(notes);
  expect(meeting.startMessageId).toBe(published.id);
  expect(fetchChannel).toHaveBeenCalledTimes(1);
  expect(initializeMeeting).toHaveBeenCalledTimes(1);
  meeting.attendance = new Set();
  meeting.endTime = new Date("2026-10-16T00:05:00Z");
  meeting.notesText = "Finished notes";
  meeting.generateNotes = true;
  const fetchPublished = jest
    .spyOn(notes.messages, "fetch")
    .mockResolvedValue(published);
  const editPublished = jest
    .spyOn(published, "edit")
    .mockResolvedValue(published);
  await updateMeetingProcessingMessage(meeting);
  await updateMeetingSummaryMessage(meeting);
  expect(fetchPublished).toHaveBeenNthCalledWith(1, published.id);
  expect(fetchPublished).toHaveBeenNthCalledWith(2, published.id);
  expect(editPublished).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledTimes(2);
  expect(meeting.notesChannelId).toBe(notes.id);
  expect(invocation.send).not.toHaveBeenCalled();
});

test("starter access is checked before named bot permission errors", async () => {
  jest
    .spyOn(notes, "permissionsFor")
    .mockReturnValue(new PermissionsBitField());
  jest.mocked(checkBotPermissions).mockReturnValue({
    success: false,
    errorMessage: "private-notes is missing bot permissions",
  });
  const request = interaction();
  await handleRequestStartMeeting(request);
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(checkBotPermissions).not.toHaveBeenCalled();
  expect(request.editReply).toHaveBeenCalledWith(
    expect.not.stringContaining("private-notes"),
  );
});

test.each([
  ["early lease lookup", getActiveMeetingLeaseForGuild],
  ["artifact access lookup", resolveServerMeetingArtifactAccess],
  ["voice settings lookup", resolveMeetingVoiceSettings],
  ["subscription lookup", getGuildLimits],
])(
  "%s rejection completes the deferred reply before initialization",
  async (_, lookup) => {
    const failure = new Error("private-notes voice-notes lookup unavailable");
    jest.mocked(lookup).mockRejectedValueOnce(failure);
    const request = interaction();
    await expect(handleRequestStartMeeting(request)).resolves.toBeUndefined();
    expect(request.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(request.editReply).toHaveBeenCalledTimes(1);
    expect(request.editReply).toHaveBeenCalledWith(
      "Recording could not be started. Please try again.",
    );
    expect(warning).toHaveBeenCalledWith(
      "Failed to prepare or start meeting",
      expect.objectContaining({ guildId: guild.id, error: failure }),
    );
    expect(initializeMeeting).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(invocation.send).not.toHaveBeenCalled();
    expect(interruptOwnedMeeting).not.toHaveBeenCalled();
  },
);

test("a live lease rejects admission before publication", async () => {
  jest.mocked(getActiveMeetingLeaseForGuild).mockResolvedValueOnce({
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 60,
  } as never);
  const request = interaction();
  await handleRequestStartMeeting(request);
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(request.editReply).toHaveBeenCalledWith(
    expect.stringContaining("already active"),
  );
});

test("initial recovery history and lease retain the routed text channel", async () => {
  await handleRequestStartMeeting(interaction());
  const source = ts.createSourceFile(
    "meetings.ts",
    readFileSync(path.join(__dirname, "../../src/meetings.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "initializeNewMeeting",
  );
  if (!declaration) throw new Error("Missing initializer");
  const acquire = jest.fn(async () => ({
    kind: "blocked",
    reason: "deployment",
  }));
  const context = vm.createContext({
    options: jest.mocked(initializeMeeting).mock.calls[0][0],
    reservationTimingReceipt: () => undefined,
    tryAcquireMeetingLease: acquire,
  });
  await expect(
    vm.runInContext(
      ts.transpileModule(
        declaration.getText(source) + "\ninitializeNewMeeting(options);",
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      context,
    ),
  ).rejects.toThrow("admission blocked");
  expect(acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      textChannelId: notes.id,
      history: expect.objectContaining({ textChannelId: notes.id }),
    }),
  );
});

test("rolling limits use the deferred delivery policy before publication", async () => {
  const resolved = await getGuildLimits(guild.id);
  jest.mocked(getGuildLimits).mockResolvedValueOnce({
    ...resolved,
    limits: { ...resolved.limits, maxMeetingMinutesRolling: 240 },
  });
  jest.mocked(getRollingUsageForGuild).mockResolvedValueOnce({
    usedSeconds: 240 * 60,
    meetings: [],
    windowStartIso: "2026-10-01T00:00:00Z",
    windowEndIso: "2026-10-08T00:00:00Z",
    nextAvailableAtIso: null,
  });
  jest
    .mocked(encounterRecordingLimit)
    .mockImplementationOnce(async (input) =>
      createUpgradeRecordingLimitNotice(input),
    );
  const request = interaction();
  await handleRequestStartMeeting(request);
  expect(deliverRecordingLimitNotice).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Function),
    "edit",
  );
  expect(request.editReply).toHaveBeenCalledWith(
    expect.objectContaining({
      content: expect.stringContaining("limit reached"),
      allowedMentions: { parse: [] },
    }),
  );
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("the invocation channel needs no public posting permission for a routed start", async () => {
  jest
    .spyOn(invocation, "permissionsFor")
    .mockReturnValue(new PermissionsBitField());
  await handleRequestStartMeeting(interaction());
  expect(send).toHaveBeenCalledTimes(1);
  expect(invocation.send).not.toHaveBeenCalled();
});

test("a missing configured destination blocks instead of falling back", async () => {
  fetchChannel.mockResolvedValueOnce(null);
  const request = interaction();
  await handleRequestStartMeeting(request);
  expect(request.editReply).toHaveBeenCalledWith(
    expect.stringContaining("notes channel is unavailable"),
  );
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(invocation.send).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("initialization rejection does not publish or invent a success link", async () => {
  jest
    .mocked(initializeMeeting)
    .mockRejectedValueOnce(new Error("recording admission rejected"));
  const request = interaction();
  await expect(handleRequestStartMeeting(request)).resolves.toBeUndefined();
  expect(send).not.toHaveBeenCalled();
  expect(invocation.send).not.toHaveBeenCalled();
  expect(initializeMeeting).toHaveBeenCalledTimes(1);
  expect(request.editReply).toHaveBeenCalledTimes(1);
  expect(request.editReply).toHaveBeenCalledWith(
    "Recording could not be started. Please try again.",
  );
  expect(warning).toHaveBeenCalledWith(
    "Failed to prepare or start meeting",
    expect.objectContaining({ error: expect.any(Error) }),
  );
  expect(interruptOwnedMeeting).not.toHaveBeenCalled();
});

test("accessible destination bot permissions are checked at that destination", async () => {
  jest.mocked(checkBotPermissions).mockReturnValueOnce({
    success: false,
    errorMessage: "Missing bot permissions in private-notes.",
  });
  const request = interaction();
  await handleRequestStartMeeting(request);
  expect(checkBotPermissions).toHaveBeenCalledWith(voice, notes, botMember);
  expect(request.editReply).toHaveBeenCalledWith(
    "Missing bot permissions in private-notes.",
  );
  expect(initializeMeeting).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

test("routed starts preserve context, tags, controls and live transcript access", async () => {
  const request = interaction();
  if (!request.isChatInputCommand()) throw new Error("Expected slash command");
  jest
    .spyOn(request.options, "getString")
    .mockImplementation((name) =>
      name === "context" ? "Planning" : name === "tags" ? "roadmap,team" : null,
    );
  jest.mocked(resolveServerMeetingArtifactAccess).mockResolvedValueOnce({
    transcriptAccessEnabled: true,
    audioAccessEnabled: true,
  });
  await handleRequestStartMeeting(request);
  expect(initializeMeeting).toHaveBeenCalledWith(
    expect.objectContaining({
      meetingContext: "Planning",
      tags: ["roadmap", "team"],
      textChannel: notes,
    }),
  );
  const payload = send.mock.calls[0][0];
  expect(payload.components[0].toJSON().components).toEqual([
    expect.objectContaining({ custom_id: "end_meeting" }),
    expect.objectContaining({ custom_id: "edit_tags" }),
    expect.objectContaining({
      label: "Live transcript",
      url: expect.stringContaining("/live/guild-1/meeting-1"),
    }),
  ]);
});
