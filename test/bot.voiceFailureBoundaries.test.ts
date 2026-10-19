/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";

// Execute the production registrations without starting Discord or importing cloud clients.
function loadVoiceBoundary(rejectSubscription: () => Promise<void>) {
  const file = path.join(__dirname, "../src/bot.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const functions = source.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      ["setupBot", "handleVoiceStateUpdate", "handleUserJoin"].includes(
        node.name?.text ?? "",
      ),
  );
  expect(functions).toHaveLength(3);
  const client = Object.assign(new EventEmitter(), {
    user: { id: "synthetic-bot" },
    login: jest.fn().mockResolvedValue(undefined),
  });
  const meeting = {
    meetingId: "synthetic-meeting",
    voiceChannel: { id: "synthetic-voice" },
    participants: new Map(),
    attendance: new Set(),
    chatLog: [],
    audioData: {},
    finishing: false,
  };
  const warn = jest.fn();
  const context = vm.createContext({
    client,
    TOKEN: "synthetic-token",
    CLIENT_ID: "synthetic-client",
    Events: { ClientReady: "ready" },
    console: { log: jest.fn(), warn, error: jest.fn() },
    setDiscordClient: jest.fn(),
    registerServingBotStartup: jest.fn(),
    isRuntimeWarm: () => false,
    startMeetingControlCommandWorker: jest.fn(),
    setupApplicationCommands: jest.fn(),
    recordSuppressionVoiceState: jest.fn(),
    getMeeting: () => meeting,
    isMeetingCollectingEvents: () => true,
    fromMember: () => ({ id: "synthetic-user" }),
    formatParticipantLabel: () => "Synthetic",
    formatUserMention: () => "Synthetic",
    subscribeToUserVoice: rejectSubscription,
  });
  vm.runInContext(
    ts.transpileModule(
      functions
        .map((node) => node.getText(source).replace(/^export /, ""))
        .join("\n") + "\nsetupBot();",
      {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      },
    ).outputText,
    context,
  );
  client.emit("ready");
  return { client, warn, meeting };
}

test("the registered voice-state boundary consumes a subscription rejection once with sanitized metadata", async () => {
  const { client, warn, meeting } = loadVoiceBoundary(async () => {
    throw new Error("private participant and error details");
  });
  const oldState = {
    guild: { id: "synthetic-guild" },
    channel: null,
    channelId: null,
  };
  const newState = {
    guild: oldState.guild,
    channel: {},
    channelId: "synthetic-voice",
    member: { user: { id: "synthetic-user", username: "private name" } },
  };
  client.emit("voiceStateUpdate", oldState, newState);
  await new Promise((resolve) => setImmediate(resolve));
  expect(warn.mock.calls).toEqual([
    [
      "Voice state operation failed:",
      { stage: "voice-state-update", meetingId: "synthetic-meeting" },
    ],
  ]);
  expect(meeting.participants.has("synthetic-user")).toBe(true);
});

test("the registered voice-state boundary keeps a successful subscription silent", async () => {
  const { client, warn } = loadVoiceBoundary(async () => {});
  const oldState = {
    guild: { id: "synthetic-guild" },
    channel: null,
    channelId: null,
  };
  client.emit("voiceStateUpdate", oldState, {
    ...oldState,
    channel: {},
    channelId: "synthetic-voice",
    member: { user: { id: "synthetic-user" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(warn).not.toHaveBeenCalled();
});

import {
  ChannelType,
  Client,
  Guild,
  TextChannel,
  VoiceChannel,
  SlashCommandBuilder,
  REST,
  Routes,
} from "discord.js";
import { CONFIG_KEYS } from "../src/config/keys";
import { getGlobalConfigValues } from "../src/services/appConfigService";
import { listConfigOverridesForScope } from "../src/services/configOverridesService";
import { getAutoRecordSettingByChannel } from "../src/services/autorecordService";
import { resolveMeetingNotesChannel } from "../src/services/meetingNotesDestinationService";
import {
  getSnapshotString,
  resolveConfigSnapshot,
} from "../src/services/unifiedConfigService";
import { MEETING_START_REASONS } from "../src/types/meetingLifecycle";
import { parseTags } from "../src/utils/tags";

jest.mock("../src/services/appConfigService", () => ({
  getGlobalConfigValues: jest.fn(),
}));
jest.mock("../src/services/configOverridesService", () => ({
  listConfigOverridesForScope: jest.fn(),
}));

function readBotFunction(name: string) {
  const source = ts.createSourceFile(
    "bot.ts",
    readFileSync(path.join(__dirname, "../src/bot.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing production bot function: ${name}`);
  return declaration.getText(source);
}

async function runAutoRecordJoin(options: {
  voiceDestination?: string;
  serverDestination?: string;
  destinationMissing?: boolean;
}) {
  jest.mocked(getGlobalConfigValues).mockResolvedValue({});
  jest.mocked(listConfigOverridesForScope).mockImplementation(async (scope) => {
    const values =
      scope.scope === "server"
        ? {
            [CONFIG_KEYS.autorecord.enabled]: true,
            [CONFIG_KEYS.notes.channelId]: options.serverDestination,
            [CONFIG_KEYS.notes.tags]: "server-tag",
          }
        : { [CONFIG_KEYS.notes.channelId]: options.voiceDestination };
    return Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([configKey, value]) => ({
        scopeId: `${scope.scope}#guild-1`,
        configKey,
        value,
        updatedAt: "2026-10-16T00:00:00Z",
        updatedBy: "admin-1",
      }));
  });
  const discord = new Client({ intents: [] });
  const guild: Guild = Reflect.construct(Guild, [discord, { id: "guild-1" }]);
  const voiceChannel: VoiceChannel = Reflect.construct(VoiceChannel, [
    guild,
    { id: "voice-1", name: "Voice", type: ChannelType.GuildVoice },
    guild.client,
  ]);
  const notesChannel: TextChannel = Reflect.construct(TextChannel, [
    guild,
    { id: "voice-notes", name: "private-notes", type: ChannelType.GuildText },
    guild.client,
  ]);
  const fetchChannel = jest
    .spyOn(guild.channels, "fetch")
    .mockResolvedValue(options.destinationMissing ? null : notesChannel);
  const start = jest.fn().mockResolvedValue(true);
  const tts = jest.fn();
  const admission = jest.fn();
  const errors = jest.fn();
  const declaration = readBotFunction("handleUserJoin");
  const context = vm.createContext({
    client: { user: { id: "bot-1" } },
    getMeeting: () => undefined,
    isMeetingCollectingEvents: () => false,
    getActiveMeetingLease: async () => undefined,
    autoRecordJoinSuppressionService: {
      shouldSuppressAutoJoin: async () => false,
    },
    getAutoRecordSettingByChannel,
    getGuildLimits: async () => ({
      subscription: { tier: "free" },
      limits: {},
    }),
    resolveConfigSnapshot,
    getSnapshotString,
    CONFIG_KEYS,
    parseTags,
    resolveMeetingNotesChannel,
    resolveMeetingVoiceSettings: async () => ({}),
    MEETING_START_REASONS,
    handleAutoStartMeeting: start,
    assertServingBotAdmission: admission,
    maybeStartAutoTtsOnly: tts,
    console: { log: jest.fn(), error: errors, warn: jest.fn() },
    newState: {
      guild,
      channel: voiceChannel,
      channelId: voiceChannel.id,
      member: { user: { id: "trigger-1" } },
    },
  });
  await vm.runInContext(
    ts.transpileModule(declaration + "\nhandleUserJoin(newState, true);", {
      compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    context,
  );
  return {
    start,
    tts,
    fetchChannel,
    notesChannel,
    voiceChannel,
    admission,
    errors,
  };
}

test("auto-record-all uses a notes-only voice override and preserves its rule and tags", async () => {
  const { start, notesChannel, voiceChannel, admission, fetchChannel } =
    await runAutoRecordJoin({
      voiceDestination: "voice-notes",
      serverDestination: "server-notes",
    });
  expect(fetchChannel).toHaveBeenCalledWith("voice-notes");
  expect(start).toHaveBeenCalledWith(
    expect.anything(),
    voiceChannel,
    notesChannel,
    expect.objectContaining({
      assertAdmission: admission,
      tags: ["server-tag"],
      startReason: MEETING_START_REASONS.AUTO_RECORD_ALL,
      startTriggeredByUserId: "trigger-1",
      autoRecordRule: { mode: "all", channelId: "ALL" },
    }),
  );
});

test("unconfigured auto-record cannot use an invocation fallback", async () => {
  const { start, fetchChannel, tts } = await runAutoRecordJoin({});
  expect(fetchChannel).not.toHaveBeenCalled();
  expect(start).not.toHaveBeenCalled();
  expect(tts).not.toHaveBeenCalled();
});

test("a missing configured auto destination does not start elsewhere", async () => {
  const { start, fetchChannel, tts } = await runAutoRecordJoin({
    voiceDestination: "missing-notes",
    serverDestination: "server-notes",
    destinationMissing: true,
  });
  expect(fetchChannel).toHaveBeenCalledTimes(1);
  expect(fetchChannel).toHaveBeenCalledWith("missing-notes");
  expect(start).not.toHaveBeenCalled();
  expect(tts).not.toHaveBeenCalled();
});

test("registered startmeeting offers an optional ordinary text notes channel", async () => {
  const declaration = readBotFunction("setupApplicationCommands");
  const put = jest.spyOn(REST.prototype, "put").mockResolvedValue([]);
  const command = new SlashCommandBuilder()
    .setName("fixture")
    .setDescription("Fixture");
  const context = vm.createContext({
    SlashCommandBuilder,
    ChannelType,
    REST,
    Routes,
    TOKEN: "fake",
    CLIENT_ID: "bot-1",
    config: {
      server: { onboardingEnabled: false },
      chatTts: { maxChars: 100 },
    },
    TTS_VOICE_CHOICES: [{ name: "Alloy", value: "alloy" }],
    TTS_PREFIX_MODE_CHOICES: [{ name: "Default", value: "default" }],
    MIN_TTS_VOLUME_PERCENT: 0,
    MAX_TTS_VOLUME_PERCENT: 200,
    billingCommand: command,
    dismissAutoRecordCommand: command,
    startMeetingContextCommand: command,
    console: { log: jest.fn(), error: jest.fn() },
  });
  try {
    await vm.runInContext(
      ts.transpileModule(declaration + "\nsetupApplicationCommands();", {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
      context,
    );
    expect(put).toHaveBeenCalledWith(
      Routes.applicationCommands("bot-1"),
      expect.objectContaining({
        body: expect.arrayContaining([
          expect.objectContaining({
            name: "startmeeting",
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
        ]),
      }),
    );
  } finally {
    put.mockRestore();
  }
});
