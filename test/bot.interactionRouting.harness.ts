/**
 * Drives the real bot handlers of two workers loaded side by side, with fake
 * registry, lease and receipt stores shared between them the way DynamoDB is.
 * Every bot routing suite imports this first: its mocks must be registered
 * before either worker loads the bot.
 */
import type { Client } from "discord.js";

export type MockWorker = {
  name: string;
  eligible: boolean;
  shuttingDown: boolean;
  live?: {
    guildId: string;
    meetingId: string;
    voiceChannel: { id: string; members: { size: number } };
    textChannel: { send: () => Promise<void> };
    endReason?: string;
  };
  starting?: string;
  client?: Client;
  config?: {
    server: { onboardingEnabled: boolean };
    frontend: { siteUrl: string };
  };
};
type MockLease = {
  meetingId: string;
  guildId: string;
  voiceChannelId: string;
  ownerInstanceId: string;
  leaseExpiresAt: number;
  startTriggeredByUserId?: string;
  sessionMode?: "meeting" | "tts_only";
  isAutoRecording: boolean;
};

export const mockWorld = {
  loading: undefined as MockWorker | undefined,
  receipts: new Set<string>(),
  receiptFailure: undefined as "throw" | "hang" | undefined,
  dismissRefusal: undefined as string | undefined,
  lease: async (): Promise<MockLease | undefined> => undefined,
  events: [] as string[],
  endRequests: [] as unknown[][],
  subscribeFailure: false,
  autoRecordAll: false,
  destinationMissing: false,
  autostarts: [] as unknown[][],
  participants: 0,
  clearedMembers: [] as string[][],
  installer: undefined as { installerId: string } | undefined,
  installerLookups: [] as unknown[][],
};
const mockRecord = (worker: MockWorker, event: string) =>
  mockWorld.events.push(`${event}:${worker.name}`);
const mockLoadingWorker = () => {
  const worker = mockWorld.loading;
  if (!worker) throw new Error("A worker module loaded outside loadWorker");
  return worker;
};
const mockHandler = (name: string) => {
  const worker = mockLoadingWorker();
  return async (...args: unknown[]) => {
    mockRecord(worker, `handle-${name}`);
    const interaction = args.find(
      (arg): arg is { reply: (value: unknown) => Promise<void> } =>
        typeof arg === "object" && arg !== null && "reply" in arg,
    );
    await interaction?.reply({ content: `handled ${name}` });
  };
};

jest.mock("../src/services/workerRegistry", () => {
  const worker = mockLoadingWorker();
  return {
    isEligible: () => worker.eligible,
    isWorkerFresh: () => false,
  };
});
jest.mock("../src/services/shutdownSignal", () => {
  const worker = mockLoadingWorker();
  return {
    isShuttingDown: () => worker.shuttingDown,
    operationSignal: (...extra: AbortSignal[]) => AbortSignal.any(extra),
    getShutdownSignal: () => new AbortController().signal,
    beginShutdown: () => undefined,
  };
});
jest.mock("../src/db", () => {
  const worker = mockLoadingWorker();
  return {
    tryCreateInteractionReceipt: async (
      receipt: { interactionId: string },
      _replaceExpiredBefore?: number,
      signal?: AbortSignal,
    ) => {
      mockRecord(worker, "receipt");
      if (mockWorld.receiptFailure === "throw")
        throw new Error("synthetic receipt store failure");
      if (mockWorld.receiptFailure === "hang")
        return new Promise<boolean>((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      if (mockWorld.receipts.has(receipt.interactionId)) return false;
      mockWorld.receipts.add(receipt.interactionId);
      return true;
    },
    getActiveMeetingLease: async () => {
      mockRecord(worker, "lease");
      return mockWorld.lease();
    },
    requestActiveMeetingEnd: async (...args: unknown[]) => {
      mockWorld.endRequests.push(args);
      return true;
    },
    getDeploymentControlRepository: () => ({}),
  };
});
jest.mock("../src/meetings", () => {
  const worker = mockLoadingWorker();
  return {
    getMeeting: (guildId: string) =>
      worker.live?.guildId === guildId ? worker.live : undefined,
    getStartingMeetingId: () => worker.starting,
    initializeMeeting: jest.fn(),
  };
});
jest.mock("../src/commands/startMeeting", () => {
  const autostart = mockHandler("autostart");
  return {
    handleRequestStartMeeting: mockHandler("startmeeting"),
    handleAutoStartMeeting: async (...args: unknown[]) => {
      mockWorld.autostarts.push(args);
      await autostart(...args);
    },
  };
});
jest.mock("../src/commands/ask", () => ({
  handleAskCommand: mockHandler("ask"),
}));
jest.mock("../src/commands/endMeeting", () => ({
  handleEndMeetingButton: mockHandler("end"),
  handleEndMeetingOther: mockHandler("end-other"),
  persistAutoRecordSuppression: async () => false,
}));
jest.mock("../src/commands/leave", () => ({
  LEAVE_CONFIRM_PROMPT: "synthetic confirm prompt",
  handleLeaveCommand: mockHandler("leave"),
}));
jest.mock("../src/commands/onboard", () => ({
  isOnboardButton: (id: string) => id === "onboard_auto_all",
  isOnboardModal: (id: string) => id === "onboard_context_modal",
  isOnboardChannelSelect: (id: string) => id === "onboard_voice",
  handleOnboardCommand: mockHandler("onboard"),
  handleOnboardButtonInteraction: mockHandler("onboard-button"),
  handleOnboardModalSubmit: mockHandler("onboard-modal"),
  handleOnboardChannelSelect: mockHandler("onboard-select"),
}));
jest.mock("../src/commands/say", () => ({
  handleSayCommand: mockHandler("say"),
}));
jest.mock("../src/commands/dismissAutoRecord", () => ({
  DISMISS_AUTORECORD_COMMAND_NAME: "Stop recording",
  dismissAutoRecordCommand: {},
  handleDismissAutoRecord: mockHandler("dismiss"),
  autoRecordStopRefusal: async () => mockWorld.dismissRefusal,
}));
jest.mock("../src/commands/tts", () => ({
  handleTtsCommand: mockHandler("tts"),
  handleWhoisCommand: mockHandler("whois"),
}));
jest.mock("../src/commands/generateImage", () => ({
  generateAndSendImage: mockHandler("generate-image"),
}));
jest.mock("../src/commands/tags", () => ({
  isEditTagsButton: (id: string) => id === "edit_tags",
  isEditTagsModal: (id: string) => id === "edit_tags_modal",
  isEditTagsHistoryButton: () => false,
  isEditTagsHistoryModal: () => false,
  handleEditTagsButton: mockHandler("edit-tags"),
  handleEditTagsModal: mockHandler("edit-tags-modal"),
  handleEditTagsHistoryButton: mockHandler("edit-tags-history"),
  handleEditTagsHistoryModal: mockHandler("edit-tags-history-modal"),
}));
jest.mock("../src/services/runtimeInstanceService", () => {
  const worker = mockLoadingWorker();
  return {
    ...jest.requireActual("../src/services/runtimeInstanceService"),
    getRuntimeInstanceId: () => `synthetic-instance-${worker.name}`,
  };
});
jest.mock("../src/services/analyticsService", () => {
  const worker = mockLoadingWorker();
  return {
    captureEvent: (name: string) => mockRecord(worker, `capture-${name}`),
  };
});
jest.mock("../src/services/guildInstallerOnboardingService", () => ({
  waitForGuildInstaller: async (...args: unknown[]) => {
    mockWorld.installerLookups.push(args);
    return mockWorld.installer;
  },
}));
jest.mock("../src/services/guildInstallerService", () => {
  const worker = mockLoadingWorker();
  return {
    removeGuildInstaller: async () => mockRecord(worker, "remove-installer"),
  };
});
jest.mock("../src/services/discordCacheService", () => {
  const worker = mockLoadingWorker();
  return {
    invalidateDiscordBotGuildsCache: async () =>
      mockRecord(worker, "invalidate"),
    invalidateDiscordGuildCache: async () => mockRecord(worker, "invalidate"),
    invalidateDiscordUserCache: async () => undefined,
  };
});
jest.mock("../src/services/autoRecordJoinSuppressionService", () => {
  const worker = mockLoadingWorker();
  return {
    autoRecordJoinSuppressionService: {
      clearIfEmpty: async (options: { nonBotMemberIds: () => string[] }) => {
        mockWorld.clearedMembers.push(options.nonBotMemberIds());
        mockRecord(worker, "suppression-clear");
      },
      shouldSuppressAutoJoin: async () => false,
    },
  };
});
jest.mock("../src/services/autorecordService", () => {
  const worker = mockLoadingWorker();
  return {
    getAutoRecordSettingByChannel: async (
      _guildId: string,
      channelId: string,
    ) => {
      mockRecord(worker, "autorecord-evaluated");
      return mockWorld.autoRecordAll && channelId === "ALL"
        ? { enabled: true, recordAll: true, channelId: "ALL" }
        : undefined;
    },
  };
});
jest.mock("../src/services/subscriptionService", () => ({
  getGuildLimits: async () => ({ subscription: { tier: "free" }, limits: {} }),
}));
jest.mock("../src/services/meetingVoiceSettingsService", () => ({
  resolveMeetingVoiceSettings: async () => ({}),
}));
jest.mock("../src/botMeetingEnd", () => {
  const worker = mockLoadingWorker();
  return {
    endMeetingWithNotice: async () => mockRecord(worker, "end-with-notice"),
  };
});
jest.mock("../src/services/recordingParticipantService", () => ({
  recordMeetingParticipantEvent: () => {
    mockWorld.participants += 1;
    return true;
  },
}));
jest.mock("../src/audio", () => ({
  subscribeToUserVoice: async () => {
    if (mockWorld.subscribeFailure)
      throw new Error("private participant and error details");
  },
  unsubscribeToVoiceUponLeaving: () => undefined,
}));
jest.mock("../src/services/meetingNotesDestinationService", () => ({
  resolveMeetingNotesChannel: async () => {
    if (mockWorld.destinationMissing)
      throw new Error("The notes channel is unavailable.");
    return { id: "synthetic-notes" };
  },
}));
jest.mock("../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: async () => ({ values: {} }),
  getSnapshotString: (_snapshot: unknown, key: string) =>
    key === "notes.tags" ? "server-tag" : undefined,
}));

export const GUILD = "synthetic-routing-guild";
export const MEETING = "synthetic-routing-meeting";
export const USER = "synthetic-routing-user";
export const ENDED_REPLY = "The recording has ended. Notes will follow.";
export const GUILD_RECEIPT_CLAIM_MS = 30_000;
const LEASE_TTL_SECONDS = 30;

export const workerA: MockWorker = {
  name: "A",
  eligible: true,
  shuttingDown: false,
};
export const workerB: MockWorker = {
  name: "B",
  eligible: true,
  shuttingDown: false,
};

async function loadWorker(worker: MockWorker) {
  mockWorld.loading = worker;
  await jest.isolateModulesAsync(async () => {
    const discord = await import("discord.js");
    jest
      .spyOn(discord.Client.prototype, "login")
      .mockImplementation(async function (this: Client) {
        worker.client = this;
        return "synthetic";
      });
    const { config } = await import("../src/services/configService");
    config.server.onboardingEnabled = true;
    worker.config = config;
    const bot = await import("../src/bot");
    await bot.setupBot();
  });
  mockWorld.loading = undefined;
}

export const settle = async () => {
  for (let tick = 0; tick < 5; tick++)
    await new Promise((resolve) => setImmediate(resolve));
};
export const listener = (worker: MockWorker, event: string) =>
  worker.client!.listeners(event)[0] as (...args: unknown[]) => Promise<void>;

type InteractionKind =
  | "end"
  | "leave"
  | "say"
  | "dismiss"
  | "start"
  | "ask"
  | "tts"
  | "edit-tags"
  | "edit-tags-modal"
  | "generate-image"
  | "onboard"
  | "onboard-button"
  | "onboard-modal"
  | "onboard-select";
const BOT_USER = "synthetic-bot";
const BUTTON_IDS: Partial<Record<InteractionKind, string>> = {
  end: "end_meeting",
  "edit-tags": "edit_tags",
  "generate-image": "generate_image",
  "onboard-button": "onboard_auto_all",
};
const MODAL_IDS: Partial<Record<InteractionKind, string>> = {
  "edit-tags-modal": "edit_tags_modal",
  "onboard-modal": "onboard_context_modal",
};
const CHANNEL_SELECT_IDS: Partial<Record<InteractionKind, string>> = {
  "onboard-select": "onboard_voice",
};
const CHAT_COMMANDS: Partial<Record<InteractionKind, string>> = {
  leave: "leave",
  say: "say",
  start: "startmeeting",
  ask: "ask",
  tts: "tts",
  onboard: "onboard",
};
export function interaction(
  worker: MockWorker,
  kind: InteractionKind,
  id = `synthetic-interaction-${kind}`,
  options: { target?: string } = {},
) {
  const respond = (name: string) =>
    jest.fn(async () => {
      mockRecord(worker, name);
    });
  return {
    id,
    guildId: GUILD,
    createdTimestamp: Date.now(),
    user: { id: USER },
    client: { user: { id: BOT_USER } },
    targetUser: { id: options.target ?? BOT_USER },
    guild: {
      members: { fetch: async () => null },
      channels: { cache: new Map() },
    },
    customId:
      BUTTON_IDS[kind] ?? MODAL_IDS[kind] ?? CHANNEL_SELECT_IDS[kind] ?? "",
    commandName:
      kind === "dismiss" ? "Stop recording" : (CHAT_COMMANDS[kind] ?? ""),
    options: { getBoolean: () => true, getSubcommand: () => "stop" },
    isRepliable: () => true,
    isButton: () => kind in BUTTON_IDS,
    isChatInputCommand: () => kind in CHAT_COMMANDS,
    isUserContextMenuCommand: () => kind === "dismiss",
    isModalSubmit: () => kind in MODAL_IDS,
    isChannelSelectMenu: () => kind in CHANNEL_SELECT_IDS,
    reply: respond("reply"),
    deferReply: respond("defer"),
    editReply: respond("edit"),
    followUp: respond("follow-up"),
  };
}
const OTHER_INSTANCE = "synthetic-instance-other";
export const liveLease = (): MockLease => ({
  meetingId: MEETING,
  guildId: GUILD,
  voiceChannelId: "synthetic-voice",
  ownerInstanceId: OTHER_INSTANCE,
  leaseExpiresAt: Math.floor(Date.now() / 1000) + LEASE_TTL_SECONDS,
  startTriggeredByUserId: USER,
  sessionMode: "meeting",
  isAutoRecording: false,
});
export const liveMeeting = (members = 2): MockWorker["live"] => ({
  guildId: GUILD,
  meetingId: MEETING,
  voiceChannel: { id: "synthetic-voice", members: { size: members } },
  textChannel: { send: async () => undefined },
});
export const eventsOf = (worker: MockWorker) =>
  mockWorld.events
    .filter((event) => event.endsWith(`:${worker.name}`))
    .map((event) => event.slice(0, -`:${worker.name}`.length));

/** Loads both workers once and resets them and the shared stores before each test. */
export function useRoutingWorkers() {
  beforeAll(async () => {
    await loadWorker(workerA);
    await loadWorker(workerB);
  });
  afterAll(async () => {
    await workerA.client?.destroy();
    await workerB.client?.destroy();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    for (const worker of [workerA, workerB])
      Object.assign(worker, {
        eligible: true,
        shuttingDown: false,
        live: undefined,
        starting: undefined,
      });
    mockWorld.receipts.clear();
    mockWorld.receiptFailure = undefined;
    mockWorld.dismissRefusal = undefined;
    mockWorld.events = [];
    mockWorld.endRequests = [];
    mockWorld.subscribeFailure = false;
    mockWorld.autoRecordAll = false;
    mockWorld.destinationMissing = false;
    mockWorld.autostarts = [];
    mockWorld.participants = 0;
    mockWorld.clearedMembers = [];
    mockWorld.installer = undefined;
    mockWorld.installerLookups = [];
    mockWorld.lease = async () => undefined;
    jest.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.mocked(console.log).mockRestore();
  });
}
