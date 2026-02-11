import type { AuthedProfile } from "../trpc/context";
import type {
  AutoRecordSettings,
  GuildSubscription,
  ChannelContext,
  ServerContext,
  MeetingHistory,
  GuildInstaller,
  PaymentTransaction,
  OnboardingState,
  StripeWebhookEvent,
  UserSpeechSettings,
  ConfigOverrideRecord,
  DictionaryEntry,
  FeedbackRecord,
  MeetingShareByMeetingRecord,
  MeetingShareRecord,
} from "../types/db";
import type {
  AskConversation,
  AskMessage,
  AskSharedConversation,
} from "../types/ask";
import { CONFIG_KEYS } from "../config/keys";
import { config } from "../services/configService";
import type {
  DiscordChannel,
  DiscordGuild,
  DiscordGuildMember,
  DiscordRole,
} from "./types";

type MockStore = {
  user: AuthedProfile;
  userGuilds: DiscordGuild[];
  botGuilds: DiscordGuild[];
  channelsByGuild: Map<string, DiscordChannel[]>;
  rolesByGuild: Map<string, DiscordRole[]>;
  membersByGuild: Map<string, DiscordGuildMember>;
  objectsByKey: Map<string, string>;
  autoRecordByGuild: Map<string, AutoRecordSettings[]>;
  serverContexts: Map<string, ServerContext>;
  channelContexts: Map<string, ChannelContext>;
  guildInstallers: Map<string, GuildInstaller>;
  subscriptions: Map<string, GuildSubscription>;
  paymentTransactions: Map<string, PaymentTransaction>;
  stripeWebhookEvents: Map<string, StripeWebhookEvent>;
  onboardingStates: Map<string, OnboardingState>;
  meetingHistoryByGuild: Map<string, MeetingHistory[]>;
  meetingSharesByShareKey: Map<string, MeetingShareRecord>;
  meetingSharesByMeetingKey: Map<string, MeetingShareByMeetingRecord>;
  askConversationsByKey: Map<string, AskConversation[]>;
  askMessagesByConversation: Map<string, AskMessage[]>;
  askSharesByGuild: Map<string, AskSharedConversation[]>;
  feedbackByTarget: Map<string, FeedbackRecord[]>;
  userSpeechSettings: Map<string, UserSpeechSettings>;
  configOverrides: Map<string, ConfigOverrideRecord>;
  dictionaryEntriesByGuild: Map<string, DictionaryEntry[]>;
};

const MANAGE_GUILD = 1 << 5;
const ADMIN = 1 << 3;

const mockUser: AuthedProfile = {
  id: "211750261922725888",
  username: "MockUser",
  discriminator: "0001",
  avatar: null,
  email: "mock@chronote.gg",
  accessToken: "mock-access-token",
} as AuthedProfile;

function buildDefaultStore(): MockStore {
  const fixedNowIso = process.env.MOCK_FIXED_NOW;
  const fixedNowMs = fixedNowIso ? Date.parse(fixedNowIso) : Number.NaN;
  const baseNowMs = Number.isFinite(fixedNowMs) ? fixedNowMs : Date.now();
  const baseNowIso = new Date(baseNowMs).toISOString();
  const mockNowIso = () => baseNowIso;
  const permissions = (BigInt(MANAGE_GUILD) | BigInt(ADMIN)).toString();
  const userGuilds: DiscordGuild[] = [
    {
      id: "1249723747896918109",
      name: "DDM",
      icon: null,
      permissions,
      owner: true,
    },
    {
      id: "111111111111111111",
      name: "Chronote Crew",
      icon: null,
      permissions,
      owner: false,
    },
  ];

  const botGuilds: DiscordGuild[] = userGuilds.map((guild) => ({
    id: guild.id,
    name: guild.name,
  }));

  const channelsByGuild = new Map<string, DiscordChannel[]>();
  channelsByGuild.set("1249723747896918109", [
    { id: "voice-1", name: "General", type: 2, position: 1 },
    { id: "voice-2", name: "PTT Only (DAZ)", type: 2, position: 2 },
    { id: "voice-3", name: "Tabletop Voice", type: 2, position: 3 },
    { id: "text-1", name: "session-notes", type: 0, position: 1 },
    { id: "text-2", name: "campaign-info", type: 0, position: 2 },
    { id: "text-3", name: "roles", type: 0, position: 3 },
  ]);
  channelsByGuild.set("111111111111111111", [
    { id: "voice-a", name: "General", type: 2, position: 1 },
    { id: "voice-b", name: "Raid Room", type: 2, position: 2 },
    { id: "text-a", name: "meeting-notes", type: 0, position: 1 },
    { id: "text-b", name: "announcements", type: 0, position: 2 },
  ]);

  const rolesByGuild = new Map<string, DiscordRole[]>();
  const adminPermissions = BigInt(ADMIN).toString();
  userGuilds.forEach((guild) => {
    rolesByGuild.set(guild.id, [
      { id: guild.id, name: "@everyone", permissions: "0" },
      {
        id: `role-${guild.id}-bot`,
        name: "Chronote",
        permissions: adminPermissions,
      },
    ]);
  });

  const membersByGuild = new Map<string, DiscordGuildMember>();
  const botUserId = config.discord.clientId || "mock-bot";
  userGuilds.forEach((guild) => {
    membersByGuild.set(`${guild.id}#${botUserId}`, {
      user: { id: botUserId },
      roles: [`role-${guild.id}-bot`],
      permissions: adminPermissions,
    });
  });

  const autoRecordByGuild = new Map<string, AutoRecordSettings[]>();
  const objectsByKey = new Map<string, string>();
  autoRecordByGuild.set("1249723747896918109", [
    {
      guildId: "1249723747896918109",
      channelId: "voice-2",
      textChannelId: "text-1",
      enabled: true,
      recordAll: false,
      createdBy: mockUser.id,
      createdAt: mockNowIso(),
      tags: ["campaign", "weekly"],
    },
  ]);

  const serverContexts = new Map<string, ServerContext>();
  serverContexts.set("1249723747896918109", {
    guildId: "1249723747896918109",
    context:
      "Weekly tabletop session with rotating GMs, focus on recaps and action items.",
    defaultNotesChannelId: "text-1",
    defaultTags: ["campaign", "recap"],
    liveVoiceEnabled: false,
    liveVoiceCommandsEnabled: false,
    askMembersEnabled: true,
    askSharingPolicy: "server",
    updatedAt: mockNowIso(),
    updatedBy: mockUser.id,
  });

  const channelContexts = new Map<string, ChannelContext>();
  channelContexts.set("1249723747896918109#voice-3", {
    guildId: "1249723747896918109",
    channelId: "voice-3",
    context: "Tabletop voice channel for D&D sessions and campaign recaps.",
    liveVoiceEnabled: true,
    liveVoiceCommandsEnabled: false,
    updatedAt: mockNowIso(),
    updatedBy: mockUser.id,
  });

  const guildInstallers = new Map<string, GuildInstaller>();
  guildInstallers.set("1249723747896918109", {
    guildId: "1249723747896918109",
    installerId: mockUser.id,
    installedAt: mockNowIso(),
  });

  const subscriptions = new Map<string, GuildSubscription>();
  subscriptions.set("1249723747896918109", {
    guildId: "1249723747896918109",
    status: "active",
    tier: "basic",
    subscriptionType: "stripe",
    startDate: mockNowIso(),
    nextBillingDate: new Date(
      baseNowMs + 1000 * 60 * 60 * 24 * 25,
    ).toISOString(),
    stripeCustomerId: "cus_mock_basic",
    stripeSubscriptionId: "sub_mock_basic",
    mode: "test",
  });
  subscriptions.set("111111111111111111", {
    guildId: "111111111111111111",
    status: "free",
    tier: "free",
    subscriptionType: "free",
    startDate: mockNowIso(),
    mode: "test",
  });

  const paymentTransactions = new Map<string, PaymentTransaction>();
  const stripeWebhookEvents = new Map<string, StripeWebhookEvent>();
  const onboardingStates = new Map<string, OnboardingState>();
  const userSpeechSettings = new Map<string, UserSpeechSettings>();
  const configOverrides = new Map<string, ConfigOverrideRecord>();
  const dictionaryEntriesByGuild = new Map<string, DictionaryEntry[]>();
  const feedbackByTarget = new Map<string, FeedbackRecord[]>();

  const addOverride = (record: ConfigOverrideRecord) => {
    configOverrides.set(`${record.scopeId}#${record.configKey}`, record);
  };

  const addServerOverride = (
    guildId: string,
    configKey: string,
    value: unknown,
    updatedAt: string,
    updatedBy: string,
  ) => {
    addOverride({
      scopeId: `server#${guildId}`,
      configKey,
      value,
      updatedAt,
      updatedBy,
    });
  };

  const addChannelOverride = (
    guildId: string,
    channelId: string,
    configKey: string,
    value: unknown,
    updatedAt: string,
    updatedBy: string,
  ) => {
    addOverride({
      scopeId: `channel#${guildId}#${channelId}`,
      configKey,
      value,
      updatedAt,
      updatedBy,
    });
  };

  serverContexts.forEach((context) => {
    const updatedAt = context.updatedAt;
    const updatedBy = context.updatedBy;
    addServerOverride(
      context.guildId,
      CONFIG_KEYS.context.instructions,
      context.context,
      updatedAt,
      updatedBy,
    );
    if (context.defaultNotesChannelId) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.notes.channelId,
        context.defaultNotesChannelId,
        updatedAt,
        updatedBy,
      );
    }
    if (context.defaultTags?.length) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.notes.tags,
        context.defaultTags.join(", "),
        updatedAt,
        updatedBy,
      );
    }
    if (context.liveVoiceEnabled !== undefined) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.liveVoice.enabled,
        context.liveVoiceEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.liveVoiceCommandsEnabled !== undefined) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.liveVoice.commandsEnabled,
        context.liveVoiceCommandsEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.liveVoiceTtsVoice) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.liveVoice.ttsVoice,
        context.liveVoiceTtsVoice,
        updatedAt,
        updatedBy,
      );
    }
    if (context.chatTtsEnabled !== undefined) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.chatTts.enabled,
        context.chatTtsEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.chatTtsVoice) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.chatTts.voice,
        context.chatTtsVoice,
        updatedAt,
        updatedBy,
      );
    }
    if (context.askMembersEnabled !== undefined) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.ask.membersEnabled,
        context.askMembersEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.askSharingPolicy) {
      addServerOverride(
        context.guildId,
        CONFIG_KEYS.ask.sharingPolicy,
        context.askSharingPolicy,
        updatedAt,
        updatedBy,
      );
    }
  });

  channelContexts.forEach((context) => {
    const updatedAt = context.updatedAt;
    const updatedBy = context.updatedBy;
    if (context.context) {
      addChannelOverride(
        context.guildId,
        context.channelId,
        CONFIG_KEYS.context.instructions,
        context.context,
        updatedAt,
        updatedBy,
      );
    }
    if (context.liveVoiceEnabled !== undefined) {
      addChannelOverride(
        context.guildId,
        context.channelId,
        CONFIG_KEYS.liveVoice.enabled,
        context.liveVoiceEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.liveVoiceCommandsEnabled !== undefined) {
      addChannelOverride(
        context.guildId,
        context.channelId,
        CONFIG_KEYS.liveVoice.commandsEnabled,
        context.liveVoiceCommandsEnabled,
        updatedAt,
        updatedBy,
      );
    }
    if (context.chatTtsEnabled !== undefined) {
      addChannelOverride(
        context.guildId,
        context.channelId,
        CONFIG_KEYS.chatTts.enabled,
        context.chatTtsEnabled,
        updatedAt,
        updatedBy,
      );
    }
  });

  autoRecordByGuild.forEach((rules, guildId) => {
    rules.forEach((rule) => {
      const updatedAt = rule.createdAt;
      const updatedBy = rule.createdBy;
      if (rule.recordAll || rule.channelId === "ALL") {
        addServerOverride(
          guildId,
          CONFIG_KEYS.autorecord.enabled,
          rule.enabled,
          updatedAt,
          updatedBy,
        );
        if (rule.enabled && rule.textChannelId) {
          addServerOverride(
            guildId,
            CONFIG_KEYS.notes.channelId,
            rule.textChannelId,
            updatedAt,
            updatedBy,
          );
        }
        if (rule.enabled && rule.tags?.length) {
          addServerOverride(
            guildId,
            CONFIG_KEYS.notes.tags,
            rule.tags.join(", "),
            updatedAt,
            updatedBy,
          );
        }
        return;
      }
      addChannelOverride(
        guildId,
        rule.channelId,
        CONFIG_KEYS.autorecord.enabled,
        rule.enabled,
        updatedAt,
        updatedBy,
      );
      if (rule.enabled && rule.textChannelId) {
        addChannelOverride(
          guildId,
          rule.channelId,
          CONFIG_KEYS.notes.channelId,
          rule.textChannelId,
          updatedAt,
          updatedBy,
        );
      }
      if (rule.enabled && rule.tags?.length) {
        addChannelOverride(
          guildId,
          rule.channelId,
          CONFIG_KEYS.notes.tags,
          rule.tags.join(", "),
          updatedAt,
          updatedBy,
        );
      }
    });
  });

  const ensureServerDefault = (
    guildId: string,
    key: string,
    value: unknown,
  ) => {
    const scopeId = `server#${guildId}`;
    const mapKey = `${scopeId}#${key}`;
    if (configOverrides.has(mapKey)) return;
    addServerOverride(guildId, key, value, mockNowIso(), mockUser.id);
  };

  userGuilds.forEach((guild) => {
    ensureServerDefault(guild.id, CONFIG_KEYS.features.experimental, false);
    ensureServerDefault(guild.id, CONFIG_KEYS.autorecord.enabled, false);
    ensureServerDefault(guild.id, CONFIG_KEYS.liveVoice.enabled, false);
    ensureServerDefault(guild.id, CONFIG_KEYS.liveVoice.commandsEnabled, false);
    ensureServerDefault(guild.id, CONFIG_KEYS.chatTts.enabled, false);
    ensureServerDefault(guild.id, CONFIG_KEYS.ask.membersEnabled, true);
    ensureServerDefault(guild.id, CONFIG_KEYS.ask.sharingPolicy, "server");
    ensureServerDefault(guild.id, CONFIG_KEYS.meetings.sharingPolicy, "server");
  });

  dictionaryEntriesByGuild.set("1249723747896918109", [
    {
      guildId: "1249723747896918109",
      termKey: "chronote",
      term: "Chronote",
      definition: "Meeting Notes Bot brand name.",
      createdAt: mockNowIso(),
      createdBy: mockUser.id,
      updatedAt: mockNowIso(),
      updatedBy: mockUser.id,
    },
    {
      guildId: "1249723747896918109",
      termKey: "dynamodb",
      term: "DynamoDB",
      definition: "AWS key value and document database.",
      createdAt: mockNowIso(),
      createdBy: mockUser.id,
      updatedAt: mockNowIso(),
      updatedBy: mockUser.id,
    },
  ]);

  const meetingHistoryByGuild = new Map<string, MeetingHistory[]>();
  const meetingSharesByShareKey = new Map<string, MeetingShareRecord>();
  const meetingSharesByMeetingKey = new Map<
    string,
    MeetingShareByMeetingRecord
  >();
  const buildMeeting = (params: {
    guildId: string;
    channelId: string;
    minutesAgo: number;
    notes: string;
    tags?: string[];
    textChannelId: string;
    meetingIdSuffix: string;
    archived?: boolean;
  }): MeetingHistory => {
    const timestamp = new Date(
      baseNowMs - params.minutesAgo * 60 * 1000,
    ).toISOString();
    const channelId_timestamp = `${params.channelId}#${timestamp}`;
    const transcriptKey = `mock/transcripts/${params.guildId}/${params.channelId}-${params.meetingIdSuffix}.json`;
    const transcriptSpeakers = ["GM", "Rin", "Ada", "Chronote"];
    const transcriptLines = [
      { speaker: "GM", text: "The party returns to the vault entrance." },
      { speaker: "Rin", text: "We should secure allies before midnight." },
      { speaker: "Ada", text: "I want a favor in return." },
      ...Array.from({ length: 36 }, (_, index) => ({
        speaker: transcriptSpeakers[index % transcriptSpeakers.length],
        text: `Extended transcript detail ${index + 1} for timeline overflow.`,
      })),
    ];
    const transcriptLineIntervalMs = 60 * 1000;
    const segments = transcriptLines.map((line, index) => ({
      userId: `mock-${line.speaker.toLowerCase()}`,
      username: line.speaker.toLowerCase(),
      displayName: line.speaker,
      serverNickname: line.speaker,
      tag: line.speaker,
      startedAt: new Date(
        Date.parse(timestamp) + index * transcriptLineIntervalMs,
      ).toISOString(),
      text: line.text,
    }));
    objectsByKey.set(
      transcriptKey,
      JSON.stringify(
        {
          generatedAt: mockNowIso(),
          segments,
          text: transcriptLines
            .map((line) => `${line.speaker}: ${line.text}`)
            .join("\n"),
        },
        null,
        2,
      ),
    );
    return {
      guildId: params.guildId,
      channelId_timestamp,
      meetingId: `meeting-${params.meetingIdSuffix}`,
      channelId: params.channelId,
      timestamp,
      tags: params.tags ?? [],
      notes: params.notes,
      participants: [
        {
          id: mockUser.id,
          username: "mockuser",
          displayName: "MockUser",
          serverNickname: "MockUser",
          tag: "MockUser#0001",
        },
        {
          id: "999999999999999999",
          username: "chronote",
          displayName: "Chronote",
          serverNickname: "Chronote",
          tag: "Chronote#0000",
        },
      ],
      attendees: ["MockUser", "Chronote"],
      duration: 52 * 60,
      transcribeMeeting: true,
      generateNotes: true,
      notesChannelId: params.textChannelId,
      notesMessageIds: ["1451653357407174727"],
      transcriptS3Key: transcriptKey,
      archivedAt: params.archived ? mockNowIso() : undefined,
      archivedByUserId: params.archived ? mockUser.id : undefined,
    };
  };
  const LONG_NOTES_LINE_COUNT = 40;
  const LONG_NOTES_BLOCK = Array.from(
    { length: LONG_NOTES_LINE_COUNT },
    (_, index) =>
      `Detail ${index + 1}: Follow-up notes from the meeting timeline.`,
  ).join("\n");
  meetingHistoryByGuild.set("1249723747896918109", [
    buildMeeting({
      guildId: "1249723747896918109",
      channelId: "voice-3",
      minutesAgo: 60 * 24,
      meetingIdSuffix: "ddm-1",
      textChannelId: "text-1",
      tags: ["campaign", "heist", "npc"],
      notes: [
        "Meeting Summary (Banana / Indigo)",
        "Decision: revisit the vault after securing allies.",
        "Action: Rin posts the map + loot sheet in #campaign-info.",
        "Next time: Sunday 7pm (voice).",
        "Highlights + attendance included.",
        "",
        "Extended notes:",
        LONG_NOTES_BLOCK,
      ].join("\n"),
    }),
    buildMeeting({
      guildId: "1249723747896918109",
      channelId: "voice-2",
      minutesAgo: 60 * 48,
      meetingIdSuffix: "ddm-2",
      textChannelId: "text-3",
      tags: ["raid", "loot"],
      notes:
        "Chapter 01 - The Lemonade Stand at Dusk\nHighlights: The crew split gems evenly and banked the relic.\nAction items: verify ward timing, confirm sewer layout.",
    }),
    buildMeeting({
      guildId: "1249723747896918109",
      channelId: "voice-1",
      minutesAgo: 60 * 72,
      meetingIdSuffix: "ddm-3",
      textChannelId: "text-2",
      tags: ["community", "staff"],
      archived: true,
      notes:
        "Chapter 01 - Crossed Wires\nSummary: Staff aligned on moderation changes, event schedule, and follow-ups.",
    }),
  ]);
  meetingHistoryByGuild.set("111111111111111111", [
    buildMeeting({
      guildId: "111111111111111111",
      channelId: "voice-a",
      minutesAgo: 60 * 36,
      meetingIdSuffix: "crew-1",
      textChannelId: "text-a",
      tags: ["community", "events"],
      notes:
        "Chapter 01 - Counting In\nSummary: Event planning sync with action items and next steps.",
    }),
  ]);

  const feedbackTimestamp = mockNowIso();
  const firstMeeting = meetingHistoryByGuild.get("1249723747896918109")?.[0];
  if (firstMeeting) {
    const pk = `TARGET#meeting_summary#${firstMeeting.channelId_timestamp}`;
    feedbackByTarget.set(pk, [
      {
        pk,
        sk: `USER#${mockUser.id}`,
        type: "feedback",
        targetType: "meeting_summary",
        targetId: firstMeeting.channelId_timestamp,
        guildId: firstMeeting.guildId,
        channelId: firstMeeting.channelId,
        meetingId: firstMeeting.meetingId,
        notesVersion: firstMeeting.notesVersion,
        summarySentence: firstMeeting.summarySentence,
        summaryLabel: firstMeeting.summaryLabel,
        rating: "up",
        comment: "Clear summary and next steps.",
        source: "web",
        createdAt: feedbackTimestamp,
        updatedAt: feedbackTimestamp,
        userId: mockUser.id,
        userTag: `${mockUser.username}#${mockUser.discriminator}`,
        displayName: mockUser.username,
      },
    ]);
  }

  const askConversationsByKey = new Map<string, AskConversation[]>();
  const askMessagesByConversation = new Map<string, AskMessage[]>();
  const askSharesByGuild = new Map<string, AskSharedConversation[]>();
  const conversationId = "conv-mock-1";
  const conversationIdTwo = "conv-mock-2";
  const conversationIdThree = "conv-mock-3";
  const conversationKey = `USER#${mockUser.id}#GUILD#1249723747896918109`;
  const createdAt = mockNowIso();
  const updatedAt = mockNowIso();
  askConversationsByKey.set(conversationKey, [
    {
      id: conversationId,
      title: "Recap the last campaign session",
      summary:
        "We agreed to revisit the vault after the ranger's warning and set next steps.",
      createdAt,
      updatedAt,
    },
    {
      id: conversationIdTwo,
      title: "Loot split notes",
      summary:
        "Rin keeps the map, the party banks the gems, and we owe Ada a favor.",
      createdAt,
      updatedAt,
      visibility: "server",
      sharedAt: updatedAt,
      sharedByUserId: mockUser.id,
      sharedByTag: `${mockUser.username}#${mockUser.discriminator}`,
    },
    {
      id: conversationIdThree,
      title: "Old combat recap",
      summary: "Archived recap for a prior combat session.",
      createdAt,
      updatedAt,
      archivedAt: updatedAt,
      archivedByUserId: mockUser.id,
    },
  ]);
  askSharesByGuild.set("1249723747896918109", [
    {
      conversationId: conversationIdTwo,
      title: "Loot split notes",
      summary:
        "Rin keeps the map, the party banks the gems, and we owe Ada a favor.",
      updatedAt,
      sharedAt: updatedAt,
      ownerUserId: mockUser.id,
      ownerTag: `${mockUser.username}#${mockUser.discriminator}`,
    },
  ]);
  const basePairs = [
    [
      "What were the main decisions from the last session?",
      "The party decided to postpone the vault entry until they secure allies in town. The ranger's warning is now the top follow-up.",
    ],
    [
      "Did we lock in next session time?",
      "Yes. Sunday at 7pm in voice, with a quick recap for anyone who missed.",
    ],
    [
      "Who is taking the map update?",
      "Rin is posting the updated route and stash notes in #campaign-info.",
    ],
    [
      "Any open action items for me?",
      "Track the ward cooldown and confirm which seals reset at midnight.",
    ],
    [
      "What was the plan if the vault is still sealed?",
      "We switch to the sewer entrance and use Ada's key for the inner door.",
    ],
    [
      "What did we say about the missing scout?",
      "We agreed to ping the ranger's contact and avoid the western pass.",
    ],
    [
      "Summarize the party's goal in one sentence.",
      "Get inside the vault without triggering the ward while keeping the crew intact.",
    ],
    [
      "Did we settle the loot split?",
      "Yes. Gems are split evenly, and the relic goes to the party vault for now.",
    ],
    [
      "Any notes about the NPC Ada?",
      "Ada wants a favor in exchange for the map, and she does not trust the captain.",
    ],
    [
      "What should we review before next session?",
      "Ward timing, sewer layout, and the ranger's warning about the northern ridge.",
    ],
  ];
  const seededPairs = [
    ...basePairs,
    ...basePairs.map(([question, answer]) => [
      `${question} (follow-up)`,
      answer,
    ]),
  ];
  const seededMessages: AskMessage[] = [];
  const baseTime = baseNowMs - seededPairs.length * 6 * 60 * 1000;
  seededPairs.forEach(([question, answer], index) => {
    const questionTime = new Date(
      baseTime + index * 6 * 60 * 1000,
    ).toISOString();
    const answerTime = new Date(
      baseTime + index * 6 * 60 * 1000 + 30 * 1000,
    ).toISOString();
    seededMessages.push({
      id: `msg-${index * 2 + 1}`,
      role: "user",
      text: question,
      createdAt: questionTime,
    });
    seededMessages.push({
      id: `msg-${index * 2 + 2}`,
      role: "chronote",
      text: answer,
      createdAt: answerTime,
      sourceMeetingIds:
        index % 2 === 0 ? ["voice-2#2025-12-18T02:30:00.000Z"] : undefined,
    });
  });
  askMessagesByConversation.set(
    `${conversationKey}#${conversationId}`,
    seededMessages,
  );
  askMessagesByConversation.set(`${conversationKey}#${conversationIdTwo}`, [
    {
      id: "msg-21",
      role: "user",
      text: "Who took the emeralds?",
      createdAt,
    },
    {
      id: "msg-22",
      role: "chronote",
      text: "The party banked the emeralds in the guild vault and logged it in the recap.",
      createdAt: updatedAt,
    },
  ]);

  return {
    user: mockUser,
    userGuilds,
    botGuilds,
    channelsByGuild,
    rolesByGuild,
    membersByGuild,
    objectsByKey,
    autoRecordByGuild,
    serverContexts,
    channelContexts,
    guildInstallers,
    subscriptions,
    paymentTransactions,
    stripeWebhookEvents,
    onboardingStates,
    meetingHistoryByGuild,
    meetingSharesByShareKey,
    meetingSharesByMeetingKey,
    askConversationsByKey,
    askMessagesByConversation,
    askSharesByGuild,
    feedbackByTarget,
    userSpeechSettings,
    configOverrides,
    dictionaryEntriesByGuild,
  };
}

let store = buildDefaultStore();

export function getMockStore() {
  return store;
}

export function resetMockStore() {
  store = buildDefaultStore();
}

export function getMockUser() {
  return store.user;
}
