/** @jest-environment node */
import {
  allowFixtureActor,
  fixtureParticipant,
} from "../src/services/fixtureInputService";
import { Collection } from "discord.js";
import { recordMeetingParticipantEvent } from "../src/services/recordingParticipantService";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { createCommandRegistrationContext } from "./fixtures/botCommandRegistration";
import { createArtifactAdmissionGate } from "../src/services/artifactAdmissionGate";
import { RuntimeAdmissionUnavailable } from "../src/services/runtimeAdmissionError";
import { beginRuntimeWorkClaim } from "../src/services/runtimeWorkAdmissionService";
import * as runtimeLifecycle from "../src/services/runtimeLifecycleService";
import { context as admissionContext } from "./deployment/controlFixtures";

jest.mock("../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(),
  getRuntimeAdmissionContext: jest.fn(),
}));
jest.mock("../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
  getReservationSignal: () => new AbortController().signal,
  isReservationControlEligible: () => true,
}));

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
    recordMeetingParticipantEvent,
    allowFixtureActor,
    fixtureParticipant,
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
    member: {
      guild: { id: "synthetic-guild" },
      roles: { cache: new Collection() },
      user: { id: "synthetic-user", username: "private name" },
    },
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
    member: {
      guild: { id: "synthetic-guild" },
      roles: { cache: new Collection() },
      user: { id: "synthetic-user" },
    },
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

function readBotFunction(name: string, file = "bot.ts") {
  const source = ts.createSourceFile(
    "bot.ts",
    readFileSync(path.join(__dirname, "../src", file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!declaration) throw new Error(`Missing production bot function: ${name}`);
  return declaration.getText(source).replace(/^export /, "");
}

test.each([
  { stage: "authority", knownRefusal: true, shouldDrain: true },
  { stage: "authority", knownRefusal: false, shouldDrain: false },
  { stage: "suppression", knownRefusal: true, shouldDrain: false },
  { stage: "suppression", knownRefusal: false, shouldDrain: false },
])(
  "suppression admission drains only a known pre-operation refusal: $stage/$knownRefusal",
  async ({ stage, knownRefusal, shouldDrain }) => {
    const gate = createArtifactAdmissionGate();
    jest.mocked(runtimeLifecycle.beginRuntimeWork).mockImplementation(() => {
      const ticket = gate.begin();
      return {
        settle: () => ticket.settle(),
        transition: jest.fn(),
        beginOwnedControl: () => {
          throw new Error("Synthetic test has no owned session");
        },
      };
    });
    const error = knownRefusal
      ? new RuntimeAdmissionUnavailable("Synthetic admission closed")
      : new Error("Synthetic outcome unknown");
    const authority = jest.mocked(runtimeLifecycle.getRuntimeAdmissionContext);
    if (stage === "authority") authority.mockRejectedValue(error);
    else authority.mockResolvedValue(admissionContext);
    const clearIfEmpty = jest.fn().mockRejectedValue(error);
    const channel = { isVoiceBased: () => true };
    const sandbox = vm.createContext({
      beginRuntimeWorkClaim,
      RuntimeAdmissionUnavailable,
      getOwnedSessionReservations: () => [],
      randomUUID: () => `synthetic-${stage}-${knownRefusal}`,
      autoRecordJoinSuppressionService: { clearIfEmpty },
      oldState: {
        channelId: "synthetic-voice",
        guild: {
          id: "synthetic-guild",
          channels: { cache: new Map([["synthetic-voice", channel]]) },
        },
      },
      newState: { channelId: null },
    });
    vm.runInContext(
      ts.transpileModule(readBotFunction("recordSuppressionVoiceState"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText,
      sandbox,
    );
    await expect(
      vm.runInContext(
        "recordSuppressionVoiceState(oldState, newState)",
        sandbox,
      ),
    ).rejects.toBe(error);
    expect(clearIfEmpty).toHaveBeenCalledTimes(stage === "authority" ? 0 : 1);
    const controller = new AbortController();
    let drained = false;
    const drain = gate.seal(controller.signal).then(
      () => {
        drained = true;
      },
      () => {},
    );
    await Promise.resolve();
    controller.abort();
    await drain;
    expect(drained).toBe(shouldDrain);
    expect(gate.active).toBe(shouldDrain ? 0 : 1);
  },
);

function loadEndingNotice(
  send: () => Promise<{ delete: () => Promise<void> }>,
  autoRecording = false,
) {
  const finish = jest.fn().mockResolvedValue(undefined);
  const warn = jest.fn();
  const meeting = {
    meetingId: "synthetic-meeting",
    voiceChannel: { id: "synthetic-voice", members: new Collection() },
    textChannel: { send },
    isAutoRecording: autoRecording,
    cancelled: false,
    finished: false,
    endReason: undefined,
  };
  finish.mockImplementation(async () => {
    meeting.finished = true;
  });
  const context = vm.createContext({
    client: { user: { id: "synthetic-bot" } },
    getMeeting: () => meeting,
    isMeetingCollectingEvents: () => true,
    recordMeetingParticipantEvent: () => true,
    unsubscribeToVoiceUponLeaving: jest.fn(),
    persistAutoRecordSuppression: async () => true,
    handleEndMeetingOther: finish,
    MEETING_END_REASONS: {
      BOT_DISCONNECT: "bot_disconnect",
      CHANNEL_EMPTY: "channel_empty",
    },
    console: { log: jest.fn(), warn },
  });
  vm.runInContext(
    ts.transpileModule(
      [
        readBotFunction("handleBotVoiceUpdate"),
        readBotFunction("handleUserLeave"),
        readBotFunction("endMeetingWithNotice", "botMeetingEnd.ts"),
      ].join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    context,
  );
  const oldState = {
    guild: { id: "synthetic-guild" },
    channelId: "synthetic-voice",
    member: { user: { id: "synthetic-user" } },
  };
  const run = (event: "leave" | "disconnect") =>
    vm.runInContext(
      event === "leave"
        ? "handleUserLeave(oldState)"
        : "handleBotVoiceUpdate(oldState, { channelId: null })",
      Object.assign(context, { oldState }),
    );
  return { run, finish, meeting, warn };
}

describe.each(["leave", "disconnect"] as const)("%s end notice", (event) => {
  test("a rejected notice cannot prevent finalization", async () => {
    const { run, finish } = loadEndingNotice(async () => {
      throw new Error("private transport details");
    });
    await run(event).catch(() => undefined);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  test("a notice that never settles cannot delay finalization", async () => {
    const { run, finish } = loadEndingNotice(() => new Promise(() => {}));
    let completed = false;
    void run(event).then(() => {
      completed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(completed).toBe(true);
  });

  test("a late auto-record notice is deleted after finalization", async () => {
    let deliver:
      ((message: { delete: () => Promise<void> }) => void) | undefined;
    const send = new Promise<{ delete: () => Promise<void> }>((resolve) => {
      deliver = resolve;
    });
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run, finish, meeting } = loadEndingNotice(() => send, true);
    finish.mockImplementation(async () => {
      meeting.cancelled = true;
      meeting.finished = true;
    });
    void run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveBeenCalledTimes(1);
    if (!deliver) throw new Error("Missing synthetic transport resolver");
    deliver({ delete: remove });
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("a synchronous transport throw is contained and sanitized", async () => {
    const { run, finish, warn } = loadEndingNotice(() => {
      throw new Error("private transport details");
    });
    await run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      ["Meeting end notice failed:", { stage: "send" }],
    ]);
  });

  test("manual meeting notices remain visible", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run, finish, meeting } = loadEndingNotice(async () => ({
      delete: remove,
    }));
    await run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveBeenCalledWith(expect.anything(), meeting);
    expect(meeting.endReason).toBe(
      event === "leave" ? "channel_empty" : "bot_disconnect",
    );
    expect(remove).not.toHaveBeenCalled();
  });

  test("auto-record deletion failures cannot reject ending", async () => {
    const { run, finish, warn, meeting } = loadEndingNotice(
      async () => ({
        delete: async () => {
          throw new Error("private deletion details");
        },
      }),
      true,
    );
    finish.mockImplementation(async () => {
      meeting.cancelled = true;
      meeting.finished = true;
    });
    await run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls).toEqual([
      ["Meeting end notice failed:", { stage: "delete" }],
    ]);
  });

  test("successful auto-record notices remain visible when not cancelled", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run } = loadEndingNotice(async () => ({ delete: remove }), true);
    await run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).not.toHaveBeenCalled();
  });

  test("finalizer failure propagates without running success-only notice cleanup", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run, finish } = loadEndingNotice(
      async () => ({ delete: remove }),
      true,
    );
    const failure = new Error("synthetic finalization failure");
    finish.mockRejectedValue(failure);
    await expect(run(event)).rejects.toBe(failure);
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).not.toHaveBeenCalled();
  });

  test("a caught finalizer failure cannot delete a cancelled but unfinished notice", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run, finish, meeting } = loadEndingNotice(
      async () => ({ delete: remove }),
      true,
    );
    finish.mockImplementation(async () => {
      meeting.cancelled = true;
    });
    await run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(meeting.finished).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  test("an early cancellation notice is deleted only after finalization completes", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const { run, finish, meeting } = loadEndingNotice(
      async () => ({ delete: remove }),
      true,
    );
    let complete: (() => void) | undefined;
    finish.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const ending = run(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).not.toHaveBeenCalled();
    meeting.cancelled = true;
    meeting.finished = true;
    if (!complete) throw new Error("Missing synthetic finalization resolver");
    complete();
    await ending;
    await new Promise((resolve) => setImmediate(resolve));
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

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
  const context = createCommandRegistrationContext({
    onboardingEnabled: false,
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
