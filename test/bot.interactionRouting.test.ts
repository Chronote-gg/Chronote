/** @jest-environment node */
/**
 * Drives the real bot handlers of two workers loaded side by side, with fake
 * registry, lease and receipt stores shared between them the way DynamoDB is.
 */
import type { Client } from "discord.js";
import { buildFirstMeetingInstallerMessage } from "../src/utils/firstMeetingGuide";

type MockWorker = {
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

const mockWorld = {
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

const GUILD = "synthetic-routing-guild";
const MEETING = "synthetic-routing-meeting";
const USER = "synthetic-routing-user";
const ENDED_REPLY = "The recording has ended. Notes will follow.";
const GUILD_RECEIPT_CLAIM_MS = 30_000;
const LEASE_TTL_SECONDS = 30;

const workerA: MockWorker = { name: "A", eligible: true, shuttingDown: false };
const workerB: MockWorker = { name: "B", eligible: true, shuttingDown: false };

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

const settle = async () => {
  for (let tick = 0; tick < 5; tick++)
    await new Promise((resolve) => setImmediate(resolve));
};
const listener = (worker: MockWorker, event: string) =>
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
function interaction(
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
const liveLease = (): MockLease => ({
  meetingId: MEETING,
  guildId: GUILD,
  voiceChannelId: "synthetic-voice",
  ownerInstanceId: OTHER_INSTANCE,
  leaseExpiresAt: Math.floor(Date.now() / 1000) + LEASE_TTL_SECONDS,
  startTriggeredByUserId: USER,
  sessionMode: "meeting",
  isAutoRecording: false,
});
const liveMeeting = (members = 2): MockWorker["live"] => ({
  guildId: GUILD,
  meetingId: MEETING,
  voiceChannel: { id: "synthetic-voice", members: { size: members } },
  textChannel: { send: async () => undefined },
});
const eventsOf = (worker: MockWorker) =>
  mockWorld.events
    .filter((event) => event.endsWith(`:${worker.name}`))
    .map((event) => event.slice(0, -`:${worker.name}`.length));

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

describe("interaction routing", () => {
  test.each([true, false])(
    "owner control is handled by the recording worker, eligible or not (eligible: %s)",
    async (eligible) => {
      workerA.eligible = eligible;
      workerA.live = liveMeeting();
      mockWorld.lease = async () => liveLease();
      await listener(workerA, "interactionCreate")(interaction(workerA, "end"));
      expect(eventsOf(workerA)).toEqual(["receipt", "handle-end", "reply"]);
    },
  );

  test("owner control for a start in progress in this process is applied to that start", async () => {
    workerA.eligible = false;
    workerA.starting = MEETING;
    mockWorld.lease = async () => liveLease();
    const leave = interaction(workerA, "leave");
    await listener(workerA, "interactionCreate")(leave);
    expect(eventsOf(workerA)).toEqual(["receipt", "defer", "lease", "edit"]);
    expect(mockWorld.endRequests).toEqual([
      [GUILD, MEETING, USER, expect.any(String), "leave_command"],
    ]);
    expect(leave.editReply).toHaveBeenCalledWith(
      "Chronote is still joining. The meeting will end as soon as it has started.",
    );
  });

  test("a non-eligible worker with no live session ignores a start and writes no receipt", async () => {
    workerA.eligible = false;
    const start = interaction(workerA, "start");
    await listener(workerA, "interactionCreate")(start);
    expect(eventsOf(workerA)).toEqual([]);
    expect(mockWorld.receipts.size).toBe(0);
  });

  test("an eligible worker that does not hold the session stays silent while another worker's lease is live", async () => {
    mockWorld.lease = async () => liveLease();
    for (const kind of ["end", "leave", "say", "dismiss"] as const)
      await listener(workerA, "interactionCreate")(interaction(workerA, kind));
    expect(eventsOf(workerA)).toEqual(["lease", "lease", "lease", "lease"]);
    expect(mockWorld.receipts.size).toBe(0);
  });

  test("ended recording reply when no lease is live", async () => {
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(end.reply).toHaveBeenCalledTimes(1);
    expect(end.reply).toHaveBeenCalledWith({
      content: ENDED_REPLY,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  });

  test("an expired lease counts as no live recording", async () => {
    mockWorld.lease = async () => ({ ...liveLease(), leaseExpiresAt: 1 });
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(end.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("with nothing live, /say goes to its handler instead of the ended reply", async () => {
    await listener(workerA, "interactionCreate")(interaction(workerA, "say"));
    expect(eventsOf(workerA)).toEqual([
      "lease",
      "receipt",
      "handle-say",
      "reply",
    ]);
  });

  test("two eligible workers receive the same command: exactly one responds", async () => {
    const id = "synthetic-shared-interaction";
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "ask", id)),
      listener(workerB, "interactionCreate")(interaction(workerB, "ask", id)),
    ]);
    const responses = mockWorld.events.filter((event) =>
      event.startsWith("reply:"),
    );
    expect(responses).toHaveLength(1);
    expect(
      mockWorld.events.filter((event) => event.startsWith("handle-ask:")),
    ).toHaveLength(1);
  });

  test("two workers receiving one ended control: exactly one replies", async () => {
    const id = "synthetic-shared-control";
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "end", id)),
      listener(workerB, "interactionCreate")(interaction(workerB, "end", id)),
    ]);
    expect(
      mockWorld.events.filter((event) => event.startsWith("reply:")),
    ).toHaveLength(1);
  });

  test("the first response follows only the receipt write", async () => {
    await listener(workerA, "interactionCreate")(interaction(workerA, "end"));
    expect(eventsOf(workerA)).toEqual(["lease", "receipt", "reply"]);

    mockWorld.events = [];
    workerA.starting = MEETING;
    mockWorld.lease = async () => liveLease();
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "dismiss", "synthetic-starting-dismiss"));
    expect(eventsOf(workerA).slice(0, 2)).toEqual(["receipt", "defer"]);

    mockWorld.events = [];
    workerA.starting = undefined;
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "ask", "synthetic-general"));
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-ask", "reply"]);
  });

  test.each(["general", "ended"] as const)(
    "a claim that throws sends no reply (%s)",
    async (branch) => {
      mockWorld.receiptFailure = "throw";
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const pressed = interaction(
        workerA,
        branch === "general" ? "ask" : "end",
      );
      await listener(workerA, "interactionCreate")(pressed);
      expect(pressed.reply).not.toHaveBeenCalled();
      expect(pressed.followUp).not.toHaveBeenCalled();
      expect(pressed.editReply).not.toHaveBeenCalled();
      expect(eventsOf(workerA)).not.toContain("handle-ask");
      expect(warn).toHaveBeenCalledWith(
        "Interaction receipt claim failed; not responding",
        expect.objectContaining({ interactionId: pressed.id }),
      );
      expect(console.log).not.toHaveBeenCalledWith(
        "Skipping duplicate interaction",
        expect.anything(),
      );
      error.mockRestore();
      warn.mockRestore();
    },
  );

  test("a claim that times out sends no reply", async () => {
    mockWorld.receiptFailure = "hang";
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const pressed = interaction(workerA, "ask");
    await listener(workerA, "interactionCreate")(pressed);
    expect(pressed.reply).not.toHaveBeenCalled();
    expect(pressed.followUp).not.toHaveBeenCalled();
    expect(eventsOf(workerA)).toEqual(["receipt"]);
    expect(warn).toHaveBeenCalledWith(
      "Interaction receipt claim timed out; not responding",
      expect.objectContaining({ interactionId: pressed.id }),
    );
    error.mockRestore();
    warn.mockRestore();
  }, 5_000);

  test("a duplicate is logged as held by another worker", async () => {
    mockWorld.receipts.add("synthetic-interaction-ask");
    await listener(workerA, "interactionCreate")(interaction(workerA, "ask"));
    expect(console.log).toHaveBeenCalledWith(
      "Skipping duplicate interaction",
      expect.objectContaining({ interactionId: "synthetic-interaction-ask" }),
    );
  });

  test("edit tags during another worker's live recording is handled by the recording worker", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting();
    mockWorld.lease = async () => ({
      ...liveLease(),
      ownerInstanceId: "synthetic-instance-A",
    });
    for (const kind of ["edit-tags", "edit-tags-modal"] as const) {
      const id = `synthetic-shared-${kind}`;
      await Promise.all([
        listener(workerA, "interactionCreate")(interaction(workerA, kind, id)),
        listener(workerB, "interactionCreate")(interaction(workerB, kind, id)),
      ]);
    }
    expect(eventsOf(workerA)).toEqual([
      "receipt",
      "handle-edit-tags",
      "reply",
      "receipt",
      "handle-edit-tags-modal",
      "reply",
    ]);
    expect(eventsOf(workerB)).toEqual(["lease", "lease"]);
  });

  test("/tts stop on a draining worker's session reaches that worker", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting();
    mockWorld.lease = async () => ({
      ...liveLease(),
      ownerInstanceId: "synthetic-instance-A",
    });
    await Promise.all([
      listener(workerA, "interactionCreate")(interaction(workerA, "tts")),
      listener(workerB, "interactionCreate")(interaction(workerB, "tts")),
    ]);
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-tts", "reply"]);
    expect(eventsOf(workerB)).toEqual(["lease"]);
  });

  test("generate image with no live session runs the normal handler", async () => {
    const pressed = interaction(workerA, "generate-image");
    await listener(workerA, "interactionCreate")(pressed);
    expect(eventsOf(workerA)).toEqual([
      "lease",
      "receipt",
      "handle-generate-image",
      "reply",
    ]);
    expect(pressed.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("an owner control on this worker's own leftover lease gets the ended reply", async () => {
    mockWorld.lease = async () => ({
      ...liveLease(),
      ownerInstanceId: "synthetic-instance-A",
    });
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(end.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("Stop recording aimed at another user is not a control and gets its handler", async () => {
    const dismiss = interaction(workerA, "dismiss", undefined, {
      target: "synthetic-someone-else",
    });
    await listener(workerA, "interactionCreate")(dismiss);
    expect(eventsOf(workerA)).toEqual(["receipt", "handle-dismiss", "reply"]);
    expect(dismiss.reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: ENDED_REPLY }),
    );
  });

  test("Stop recording during a start applies the auto-record dismiss policy", async () => {
    workerA.starting = MEETING;
    mockWorld.lease = async () => ({ ...liveLease(), isAutoRecording: true });
    mockWorld.dismissRefusal = "synthetic policy refusal";
    const dismiss = interaction(workerA, "dismiss");
    await listener(workerA, "interactionCreate")(dismiss);
    expect(dismiss.editReply).toHaveBeenCalledWith("synthetic policy refusal");
    expect(mockWorld.endRequests).toEqual([]);

    mockWorld.dismissRefusal = undefined;
    await listener(
      workerA,
      "interactionCreate",
    )(interaction(workerA, "dismiss", "synthetic-allowed-dismiss"));
    expect(mockWorld.endRequests).toEqual([
      [GUILD, MEETING, USER, expect.any(String), "dismissed"],
    ]);
  });

  test("a failed lease read answers nothing", async () => {
    mockWorld.lease = async () => {
      throw new Error("synthetic lease read failure");
    };
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const end = interaction(workerA, "end");
    await listener(workerA, "interactionCreate")(end);
    expect(eventsOf(workerA)).toEqual(["lease"]);
    expect(end.reply).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "Lease read for a meeting control failed",
      expect.objectContaining({ interactionId: end.id }),
    );
    warn.mockRestore();
  });
});

describe("guild events", () => {
  const ownerSend = jest.fn(async () => undefined);
  const guild = () => ({
    id: GUILD,
    name: "Synthetic Server",
    joinedTimestamp: Date.now(),
    fetchOwner: async () => ({ user: { send: ownerSend } }),
  });
  beforeEach(() => ownerSend.mockClear());

  test("guild receipts are claimed without the interaction deadline", async () => {
    const timeout = jest.spyOn(AbortSignal, "timeout");
    await listener(workerA, "guildCreate")(guild());
    await listener(workerA, "guildDelete")(guild());
    const bounds = timeout.mock.calls.map(([ms]) => ms);
    timeout.mockRestore();
    expect(bounds).toEqual([GUILD_RECEIPT_CLAIM_MS, GUILD_RECEIPT_CLAIM_MS]);
  });

  test("install side effects are claimed once across two workers", async () => {
    const joined = guild();
    await Promise.all([
      listener(workerA, "guildCreate")(joined),
      listener(workerB, "guildCreate")(joined),
    ]);
    expect(
      mockWorld.events.filter((event) =>
        event.startsWith("capture-server_installed:"),
      ),
    ).toHaveLength(1);
    expect(ownerSend).toHaveBeenCalledTimes(1);
    expect([...mockWorld.receipts]).toEqual([
      `guild-install:${GUILD}:${joined.joinedTimestamp}`,
    ]);
  });

  test("removal side effects are claimed once across two workers", async () => {
    const removed = guild();
    await Promise.all([
      listener(workerA, "guildDelete")(removed),
      listener(workerB, "guildDelete")(removed),
    ]);
    const once = (prefix: string) =>
      mockWorld.events.filter((event) => event.startsWith(prefix));
    expect(once("capture-server_removed:")).toHaveLength(1);
    expect(once("remove-installer:")).toHaveLength(1);
    expect([...mockWorld.receipts]).toEqual([
      `guild-remove:${GUILD}:${removed.joinedTimestamp}`,
    ]);
  });

  test("a non-eligible worker does nothing on install or removal", async () => {
    workerA.eligible = false;
    await listener(workerA, "guildCreate")(guild());
    await listener(workerA, "guildDelete")(guild());
    expect(eventsOf(workerA)).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  const installerWelcome = (worker: MockWorker) =>
    buildFirstMeetingInstallerMessage({
      guildId: GUILD,
      serverName: "Synthetic Server",
      siteUrl: worker.config!.frontend.siteUrl,
    });
  const installerUser = (send: () => Promise<unknown>) =>
    jest
      .spyOn(workerA.client!.users, "fetch")
      .mockResolvedValue({ send } as never);

  test("the install welcome goes once to the recorded installer, not the owner", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    const installerSend = jest.fn(async () => undefined);
    const fetch = installerUser(installerSend);
    const joined = guild();
    try {
      await listener(workerA, "guildCreate")(joined);
      expect(fetch).toHaveBeenCalledWith("synthetic-installer");
    } finally {
      fetch.mockRestore();
    }
    expect(mockWorld.installerLookups).toEqual([
      [GUILD, joined.joinedTimestamp],
    ]);
    expect(installerSend.mock.calls).toEqual([[installerWelcome(workerA)]]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test.each(["no recorded installer", "an unreachable installer"])(
    "the install welcome falls back to the owner for %s",
    async (situation) => {
      if (situation === "an unreachable installer")
        mockWorld.installer = { installerId: "synthetic-installer" };
      const fetch = jest
        .spyOn(workerA.client!.users, "fetch")
        .mockRejectedValue(new Error("synthetic unavailable user"));
      try {
        await listener(workerA, "guildCreate")(guild());
      } finally {
        fetch.mockRestore();
      }
      expect(ownerSend.mock.calls).toEqual([[installerWelcome(workerA)]]);
    },
  );

  test("a blocked install welcome is logged once without a retry or an owner message", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    const installerSend = jest.fn(async () => {
      throw new Error("synthetic blocked DM");
    });
    const fetch = installerUser(installerSend);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await listener(workerA, "guildCreate")(guild());
      expect(warn.mock.calls).toEqual([
        ["Could not DM installer/owner on join", expect.any(Error)],
      ]);
    } finally {
      warn.mockRestore();
      fetch.mockRestore();
    }
    expect(installerSend).toHaveBeenCalledTimes(1);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test("the install welcome is not sent while installer DMs are disabled", async () => {
    mockWorld.installer = { installerId: "synthetic-installer" };
    workerA.config!.server.onboardingEnabled = false;
    try {
      await listener(workerA, "guildCreate")(guild());
    } finally {
      workerA.config!.server.onboardingEnabled = true;
    }
    expect(mockWorld.installerLookups).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test("a guild returning from an outage (guildAvailable) is not an install", async () => {
    workerA.client!.emit("guildAvailable", guild() as never);
    await settle();
    expect(workerA.client!.listenerCount("guildAvailable")).toBe(0);
    expect(eventsOf(workerA)).toEqual([]);
    expect(ownerSend).not.toHaveBeenCalled();
  });
});

describe("retired onboarding controls", () => {
  test.each([
    ["onboard", "handle-onboard"],
    ["onboard-button", "handle-onboard-button"],
    ["onboard-modal", "handle-onboard-modal"],
    ["onboard-select", "handle-onboard-select"],
  ] as const)(
    "a cached %s control reaches its retirement handler with installer DMs disabled",
    async (kind, handled) => {
      workerA.config!.server.onboardingEnabled = false;
      try {
        await listener(
          workerA,
          "interactionCreate",
        )(interaction(workerA, kind));
      } finally {
        workerA.config!.server.onboardingEnabled = true;
      }
      expect(eventsOf(workerA)).toEqual(["receipt", handled, "reply"]);
    },
  );
});

describe("voice state", () => {
  const member = { id: USER, user: { id: USER, bot: false } };
  const voiceGuild = {
    id: GUILD,
    channels: {
      cache: new Map([
        [
          "synthetic-voice",
          {
            id: "synthetic-voice",
            isVoiceBased: () => true,
            members: { filter: () => ({ map: () => [] }) },
          },
        ],
      ]),
    },
  };
  const state = (channelId: string | null) => ({
    guild: voiceGuild,
    channelId,
    channel: channelId ? { id: channelId, name: "Synthetic Voice" } : null,
    member,
  });
  const ready = (worker: MockWorker) => {
    worker.client!.user = { id: "synthetic-bot" } as never;
    if (worker.client!.listenerCount("voiceStateUpdate") === 0)
      worker.client!.emit("clientReady", worker.client as never);
  };
  const voiceUpdate = async (
    worker: MockWorker,
    from: string | null,
    to: string | null,
  ) => {
    ready(worker);
    worker.client!.emit("voiceStateUpdate", state(from), state(to));
    await settle();
  };

  test("auto-record is evaluated only by an eligible worker", async () => {
    workerA.eligible = false;
    await voiceUpdate(workerA, null, "synthetic-voice");
    await voiceUpdate(workerB, null, "synthetic-voice");
    expect(eventsOf(workerA)).not.toContain("autorecord-evaluated");
    expect(eventsOf(workerB)).toContain("autorecord-evaluated");
  });

  test("the recording worker handles its own emptied channel while draining", async () => {
    workerA.eligible = false;
    workerA.live = liveMeeting(1);
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(eventsOf(workerA)).toEqual(["end-with-notice"]);
  });

  test("the suppression clear is written only by an eligible worker that is not shutting down", async () => {
    workerA.eligible = false;
    workerB.shuttingDown = true;
    await voiceUpdate(workerA, "synthetic-voice", null);
    await voiceUpdate(workerB, "synthetic-voice", null);
    expect(eventsOf(workerA)).not.toContain("suppression-clear");
    expect(eventsOf(workerB)).not.toContain("suppression-clear");
  });

  test("an eligible worker that is not shutting down clears the suppression", async () => {
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(eventsOf(workerA)).toContain("suppression-clear");
  });

  test("the suppression clear counts only the channel's current non-bot members", async () => {
    const channel = voiceGuild.channels.cache.get("synthetic-voice")!;
    const original = channel.members;
    const present = [
      { id: "synthetic-person", user: { bot: false } },
      { id: "synthetic-other-bot", user: { bot: true } },
    ];
    channel.members = {
      filter: (keep: (member: (typeof present)[number]) => boolean) => ({
        map: (pick: (member: (typeof present)[number]) => string) =>
          present.filter(keep).map(pick),
      }),
    } as never;
    try {
      await voiceUpdate(workerA, "synthetic-voice", null);
    } finally {
      channel.members = original;
    }
    expect(mockWorld.clearedMembers).toEqual([["synthetic-person"]]);
  });

  test("a failed voice subscription on join is logged once without its details", async () => {
    workerA.live = liveMeeting(2);
    mockWorld.subscribeFailure = true;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
      expect(warn.mock.calls).toEqual([
        [
          "Voice state operation failed:",
          { stage: "voice-state-update", meetingId: MEETING },
        ],
      ]);
      expect(mockWorld.participants).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("a successful voice subscription on join logs nothing", async () => {
    workerA.live = liveMeeting(2);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("an emptied channel ends the meeting with the channel-empty reason", async () => {
    workerA.live = liveMeeting(1);
    await voiceUpdate(workerA, "synthetic-voice", null);
    expect(workerA.live?.endReason).toBe("channel_empty");
    expect(workerA.live).not.toHaveProperty("endTriggeredByUserId");
    expect(eventsOf(workerA)).toContain("end-with-notice");
  });

  test("the bot leaving the meeting channel ends it with the bot-disconnect reason", async () => {
    workerA.live = liveMeeting(2);
    ready(workerA);
    const bot = {
      id: "synthetic-bot",
      user: { id: "synthetic-bot", bot: true },
    };
    workerA.client!.emit(
      "voiceStateUpdate",
      { ...state("synthetic-voice"), member: bot },
      { ...state(null), member: bot },
    );
    await settle();
    expect(workerA.live?.endReason).toBe("bot_disconnect");
    expect(workerA.live).not.toHaveProperty("endTriggeredByUserId");
    expect(eventsOf(workerA)).toContain("end-with-notice");
  });

  test("auto-record-all starts with its rule, trigger, reason and the server tags", async () => {
    mockWorld.autoRecordAll = true;
    await voiceUpdate(workerA, null, "synthetic-voice");
    expect(mockWorld.autostarts).toHaveLength(1);
    const [, , textChannel, options] = mockWorld.autostarts[0];
    expect(textChannel).toEqual({ id: "synthetic-notes" });
    expect(options).toMatchObject({
      tags: ["server-tag"],
      startReason: "auto_record_all",
      startTriggeredByUserId: USER,
      autoRecordRule: { mode: "all", channelId: "ALL" },
    });
  });

  test("an unavailable auto-record destination starts nothing", async () => {
    mockWorld.autoRecordAll = true;
    mockWorld.destinationMissing = true;
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await voiceUpdate(workerA, null, "synthetic-voice");
    } finally {
      error.mockRestore();
    }
    expect(mockWorld.autostarts).toEqual([]);
  });

  test("a channel with no auto-record setting starts nothing", async () => {
    await voiceUpdate(workerA, null, "synthetic-voice");
    expect(mockWorld.autostarts).toEqual([]);
  });
});
