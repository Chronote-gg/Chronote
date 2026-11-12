/** @jest-environment node */
function mockEmbedModules() {
  return jest.requireActual<typeof import("./embedModuleMocks.fixture")>(
    "./embedModuleMocks.fixture",
  );
}
jest.mock("../../src/services/configService", () => ({
  config: {
    frontend: { siteUrl: "https://chronote.test" },
    discord: { botToken: "synthetic-token" },
  },
}));
jest.mock("../../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: (key: string) => ({
    up: `summary_feedback_up:${key}`,
    down: `summary_feedback_down:${key}`,
  }),
}));
jest.mock("../../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename_meeting",
}));
jest.mock(
  "../../src/services/summaryUpgradeService",
  () => mockEmbedModules().summaryUpgradeServiceModule,
);
jest.mock(
  "../../src/services/analyticsService",
  () => mockEmbedModules().analyticsServiceModule,
);
jest.mock("@langfuse/tracing", () => ({ updateActiveObservation: jest.fn() }));
jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => false,
}));

import {
  buildMeetingResultMessages,
  presentationFromMeeting,
} from "../../src/embed";
import { claimSummaryUpgrade } from "../../src/services/summaryUpgradeService";
import { DiscordMessageHttpError } from "../../src/services/discordMessageEditor";
import {
  classifyDeliveryError,
  countPostedNotes,
  deliverMeeting,
  deliverNotice,
  renderMeetingDelivery,
} from "../../src/services/meetingDelivery";
import type { MeetingHistory } from "../../src/types/db";
import { requestMeetingUpdateDelivery } from "../../src/types/meetingUpdateDelivery";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  initialMeetingUpdatePolicy,
  originalPublicationSettled,
  publicationSnapshot,
  settledLifecycleDelivery,
} from "../../src/types/meetingPublication";
import { PROCESSING_FAILED_NOTICE } from "../../src/utils/meetingProcessing";
import {
  BOT_ID,
  USER_ID,
  TEXT_CHANNEL_ID,
  VOICE_CHANNEL_ID,
  snowflake,
  GUILD_ID,
  START,
  START_MESSAGE_ID,
  POSTING_STARTS_AT,
  NOTES,
  UPGRADE,
  DONE_MARKER,
  history,
  discordMessage,
  fakeDiscord,
  savingRow,
  signal,
} from "./meetingDelivery.fixture";

function liveMeeting() {
  return {
    meetingId: "meeting-synthetic",
    guildId: GUILD_ID,
    creator: { id: "500" },
    startMessageId: START_MESSAGE_ID,
    startTime: new Date(START),
    endTime: new Date(Date.parse(START) + 3600 * 1000),
    attendance: new Set(["<@500>"]),
    voiceChannel: { id: VOICE_CHANNEL_ID, name: "Voice" },
    generateNotes: true,
    notesText: NOTES,
    summarySentence: "Synthetic summary.",
    tags: ["alpha"],
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
  };
}

type BuilderPayload = {
  embeds: { toJSON(): Record<string, unknown> }[];
  components: { toJSON(): Record<string, unknown> }[];
};
const isBuilderPayload = (value: unknown): value is BuilderPayload =>
  value !== null && typeof value === "object" && "embeds" in value;
function liveRest(payload: unknown) {
  if (!isBuilderPayload(payload)) throw new Error("Unexpected payload");
  return {
    embeds: payload.embeds.map((embed) => embed.toJSON()),
    components: payload.components.map((row) => row.toJSON()),
  };
}
const withoutTimestamps = (message: {
  embeds: Record<string, unknown>[];
  components?: Record<string, unknown>[];
}) => ({
  embeds: message.embeds.map((embed) => ({ ...embed, timestamp: undefined })),
  components: message.components,
});

/** Delivers a row on the live path through a fresh fake Discord that keeps every save. */
async function deliverLiveRow(initial: MeetingHistory) {
  const discord = fakeDiscord();
  const { save, current } = savingRow(initial);
  const outcome = await deliverMeeting({
    history: current(),
    save,
    transport: discord.transport,
    signal: signal(),
    path: "live",
  });
  return { discord, save, current, outcome };
}

describe("meeting delivery", () => {
  beforeEach(() => {
    jest.mocked(claimSummaryUpgrade).mockResolvedValue(UPGRADE);
  });
  afterEach(() => jest.restoreAllMocks());

  it("render from row equals render from live meeting for the same content", async () => {
    const rendered = buildMeetingResultMessages(
      presentationFromMeeting(liveMeeting() as unknown as MeetingData),
      UPGRADE,
    );
    const live = {
      summary: liveRest(rendered.summary),
      notes: rendered.notes.map(liveRest),
    };
    const row = renderMeetingDelivery(history(), { upgrade: UPGRADE });

    expect(row.notes.length).toBeGreaterThan(1);
    expect(row.notes).toHaveLength(live.notes.length);
    for (const message of [row.summary, ...row.notes]) {
      expect(message.allowed_mentions).toEqual({ parse: [] });
      for (const embed of message.embeds) expect(embed.timestamp).toBe(START);
    }
    const voiceField = row.summary.embeds[0].fields;
    expect(voiceField).toEqual(
      expect.arrayContaining([
        { name: "Attendees", value: "<@500>" },
        { name: "Voice Channel", value: `<#${VOICE_CHANNEL_ID}>` },
      ]),
    );
    const rowSummary = withoutTimestamps(row.summary);
    rowSummary.embeds[0] = {
      ...rowSummary.embeds[0],
      fields: live.summary.embeds[0].fields,
    };
    expect(live.summary.embeds[0].fields).toEqual(
      expect.arrayContaining([{ name: "Voice Channel", value: "Voice" }]),
    );
    expect(rowSummary).toEqual(withoutTimestamps(live.summary));
    expect(row.notes.map(withoutTimestamps)).toEqual(
      live.notes.map(withoutTimestamps),
    );
  });

  it("resume counts leading chunks by meeting timestamp", () => {
    const row = history();
    const { notes } = renderMeetingDelivery(row);
    const otherMeeting = {
      embeds: [{ ...notes[0].embeds[0], timestamp: "2026-02-01T00:00:00Z" }],
    };
    const posted = [
      discordMessage("1001", notes[0]),
      discordMessage("1002", { content: "chatter" }, USER_ID),
      discordMessage("1003", otherMeeting),
      discordMessage("1004", notes[1]),
    ].reverse();
    expect(countPostedNotes(posted, row, BOT_ID)).toBe(2);
    expect(countPostedNotes(posted, row, USER_ID)).toBe(0);
    const gap = [
      discordMessage("1001", notes[0]),
      discordMessage("1005", notes[2]),
    ];
    expect(countPostedNotes(gap, row, BOT_ID)).toBe(1);
    const secondPrecision = {
      embeds: notes[0].embeds.map((embed) => ({
        ...embed,
        timestamp: "2026-01-01T00:00:00+00:00",
      })),
    };
    expect(
      countPostedNotes([discordMessage("1001", secondPrecision)], row, BOT_ID),
    ).toBe(1);
  });

  it("403 is permanent", () => {
    expect(classifyDeliveryError(new DiscordMessageHttpError("x", 403))).toBe(
      "permanent",
    );
    expect(classifyDeliveryError(new DiscordMessageHttpError("x", 404))).toBe(
      "permanent",
    );
  });

  it("429 is temporary", () => {
    expect(
      classifyDeliveryError(new DiscordMessageHttpError("x", 429, 1)),
    ).toBe("temporary");
    expect(classifyDeliveryError(new DiscordMessageHttpError("x", 503))).toBe(
      "temporary",
    );
    expect(classifyDeliveryError(new Error("network"))).toBe("temporary");
  });

  it("delivers the summary in place and every notes chunk, then records the done marker", async () => {
    const { discord, save, current, outcome } = await deliverLiveRow(history());
    expect(outcome).toEqual({ kind: "delivered" });
    const notes = renderMeetingDelivery(history()).notes;
    const row = current();
    expect(row.summaryMessageId).toBe(START_MESSAGE_ID);
    expect(row.notesChannelId).toBe(TEXT_CHANNEL_ID);
    expect(row.notesMessageIds).toHaveLength(notes.length);
    expect(row.delivery).toEqual({
      summary: { outcome: "edited_existing", intended: 1, sent: 1, errors: [] },
      notes: {
        outcome: "complete",
        intended: notes.length,
        sent: notes.length,
        errors: [],
      },
    });
    expect(row.notesDeliveryTiming).toMatchObject({ kind: "complete" });
    expect(row.recovery).toEqual(DONE_MARKER);
    // summary, readback, one save per chunk, final
    expect(save).toHaveBeenCalledTimes(notes.length + 2);
    expect(discord.requests.filter((r) => r.method === "POST")).toHaveLength(
      notes.length,
    );
  });

  it("a delivered row satisfies originalPublicationSettled", async () => {
    const { current } = await deliverLiveRow(history());
    expect(originalPublicationSettled(publicationSnapshot(current()))).toBe(
      true,
    );
  });

  it("a correction held during delivery is released when delivery completes", async () => {
    const discord = fakeDiscord();
    const { save, current } = savingRow(history());
    const policies: unknown[] = [];
    await deliverMeeting({
      history: current(),
      save: async (patch) => {
        const saved = await save(patch);
        policies.push(initialMeetingUpdatePolicy(saved));
        return saved;
      },
      transport: discord.transport,
      signal: signal(),
      path: "live",
    });
    // Summary placed, notes still pending: the moment a correction can land.
    const policy = initialMeetingUpdatePolicy(
      history({
        summaryMessageId: START_MESSAGE_ID,
        delivery: current().delivery,
      }),
    );
    expect(policies[0]).toEqual(policy);
    expect(policy).toEqual({
      kind: "held",
      reason: "legacy_publication_unknown",
    });
    const { recovery, ...beforeDone } = current();
    const before = {
      ...beforeDone,
      updateDelivery: requestMeetingUpdateDelivery({
        history: beforeDone,
        mutation: { kind: "rename", meetingName: "Synthetic edit" },
        revision: "synthetic-edit",
        now: 100,
        policy,
      }),
    };
    const released = settledLifecycleDelivery(
      { ...publicationSnapshot(before), lifecycleVersion: 2 },
      { recovery },
    );
    expect(released?.delivery.policy).toEqual({ kind: "active" });
  });

  it("missing start message posts a new summary", async () => {
    const { discord, current, outcome } = await deliverLiveRow(
      history({ startMessageId: "999" }),
    );
    expect(outcome).toEqual({ kind: "delivered" });
    const [summaryPost] = discord.requests.filter((r) => r.method === "POST");
    expect(summaryPost.body?.embeds[0].description).toBe("Synthetic summary.");
    expect(current().summaryMessageId).toBe(
      discord.messages.find((m) => m.embeds[0]?.description)?.id,
    );
    expect(current().delivery?.summary).toEqual({
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors: [],
      recoveredMissingMessage: { code: 10008, status: 404 },
    });
  });

  it("a crash between two notes chunks resumes after the last chunk present and repeats none", async () => {
    const discord = fakeDiscord();
    const notes = renderMeetingDelivery(history()).notes;
    expect(notes).toHaveLength(3);
    discord.state.fail = (request, posts) =>
      request.method === "POST" && posts === 2
        ? new Response("{}", { status: 500 })
        : undefined;
    const first = savingRow(history());
    const outcome = await deliverMeeting({
      history: first.current(),
      save: first.save,
      transport: discord.transport,
      signal: signal(),
      path: "live",
    });
    expect(outcome).toMatchObject({ kind: "temporary" });
    expect(first.current().notesMessageIds).toEqual([
      discord.messages.at(-1)?.id,
    ]);
    expect(first.current().recovery).toBeUndefined();

    discord.state.fail = undefined;
    // The row never learned of chunk one: only the channel readback can prevent a repeat.
    const second = savingRow(history());
    await expect(
      deliverMeeting({
        history: second.current(),
        save: second.save,
        transport: discord.transport,
        signal: signal(),
        path: "live",
      }),
    ).resolves.toEqual({ kind: "delivered" });
    const posted = discord.messages.filter((m) => m.id !== START_MESSAGE_ID);
    expect(posted.map((m) => m.embeds[0].title)).toEqual(
      notes.map((n) => n.embeds[0].title),
    );
    expect(second.current().notesMessageIds).toEqual(posted.map((m) => m.id));
  });

  it("save returning undefined stops delivery", async () => {
    const discord = fakeDiscord();
    const save = jest.fn(async () => undefined);
    const outcome = await deliverMeeting({
      history: history(),
      save,
      transport: discord.transport,
      signal: signal(),
      path: "live",
    });
    expect(outcome).toMatchObject({ kind: "temporary" });
    expect(save).toHaveBeenCalledTimes(1);
    expect(discord.requests.map((r) => r.method)).toEqual(["PATCH"]);
  });

  it("classifies a permanent channel error during delivery", async () => {
    const discord = fakeDiscord();
    discord.state.fail = (request) =>
      request.method === "POST"
        ? new Response("{}", { status: 403 })
        : undefined;
    const { save } = savingRow(history());
    await expect(
      deliverMeeting({
        history: history(),
        save,
        transport: discord.transport,
        signal: signal(),
        path: "live",
      }),
    ).resolves.toMatchObject({ kind: "permanent" });
  });

  it("a row without a text channel is not applicable", async () => {
    const discord = fakeDiscord();
    const save = jest.fn();
    await expect(
      deliverMeeting({
        history: history({ textChannelId: undefined }),
        save,
        transport: discord.transport,
        signal: signal(),
        path: "live",
      }),
    ).resolves.toEqual({ kind: "not_applicable" });
    expect(save).not.toHaveBeenCalled();
    expect(discord.requests).toEqual([]);
  });

  async function run(
    discord: ReturnType<typeof fakeDiscord>,
    row: MeetingHistory,
  ) {
    const saving = savingRow(row);
    const outcome = await deliverMeeting({
      history: saving.current(),
      save: saving.save,
      transport: discord.transport,
      signal: signal(),
      path: "recovery",
    });
    return { outcome, ...saving };
  }
  const notesPosts = (discord: ReturnType<typeof fakeDiscord>) =>
    discord.requests.filter((r) => r.method === "POST");

  it("more than 100 chat messages posted during the meeting do not hide notes from a resume", async () => {
    const discord = fakeDiscord();
    discord.state.chat(150);
    const notes = renderMeetingDelivery(history()).notes;
    discord.state.fail = (request, posts) =>
      request.method === "POST" && posts === 2
        ? new Response("{}", { status: 500 })
        : undefined;
    // The crashed attempt's save never landed, so the row records nothing.
    const crashed = await deliverMeeting({
      history: history(),
      save: async (patch) => (patch.notesMessageIds ? undefined : history()),
      transport: discord.transport,
      signal: signal(),
      path: "live",
    });
    expect(crashed).toMatchObject({ kind: "temporary" });
    discord.state.fail = undefined;
    discord.requests.length = 0;

    const { outcome, current } = await run(discord, history());
    expect(outcome).toEqual({ kind: "delivered" });
    expect(notesPosts(discord).map((r) => r.body?.embeds[0].title)).toEqual(
      notes.slice(1).map((n) => n.embeds[0].title),
    );
    expect(current().notesMessageIds).toHaveLength(3);
    expect(current().notesDeliveryTiming).toMatchObject({
      kind: "complete",
      path: "recovery",
    });
  });

  it("ids recorded on the row are never reposted even when the readback cannot see them", async () => {
    const discord = fakeDiscord();
    const notes = renderMeetingDelivery(history()).notes;
    const recorded = [
      snowflake(POSTING_STARTS_AT - 2000),
      snowflake(POSTING_STARTS_AT - 1000),
    ];
    const { outcome, current } = await run(
      discord,
      history({ notesMessageIds: recorded, notesChannelId: TEXT_CHANNEL_ID }),
    );
    expect(outcome).toEqual({ kind: "delivered" });
    expect(notesPosts(discord).map((r) => r.body?.embeds[0].title)).toEqual([
      notes[2].embeds[0].title,
    ]);
    expect(current().notesMessageIds).toEqual([
      ...recorded,
      discord.messages.at(-1)?.id,
    ]);
  });

  it("a saved but unfinalised row posts nothing and completes", async () => {
    const discord = fakeDiscord();
    const recorded = ["901", "902", "903"];
    const { outcome, current, save } = await run(
      discord,
      history({ notesMessageIds: recorded, notesChannelId: TEXT_CHANNEL_ID }),
    );
    expect(outcome).toEqual({ kind: "delivered" });
    expect(discord.requests.map((r) => r.method)).toEqual(["PATCH"]);
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recovery: DONE_MARKER,
        notesDeliveryTiming: expect.objectContaining({ kind: "complete" }),
      }),
    );
    expect(current().notesMessageIds).toEqual(recorded);
    expect(originalPublicationSettled(publicationSnapshot(current()))).toBe(
      true,
    );
  });

  it("resume after recorded ids reads forward from the last recorded id", async () => {
    const discord = fakeDiscord();
    const recorded = [snowflake(POSTING_STARTS_AT - 1000)];
    await run(
      discord,
      history({ notesMessageIds: recorded, notesChannelId: TEXT_CHANNEL_ID }),
    );
    const reads = discord.requests.filter(
      (r) => r.method === "GET" && r.path.includes("/messages?"),
    );
    expect(reads.map((r) => r.path)).toEqual([
      `/channels/${TEXT_CHANNEL_ID}/messages?after=${recorded[0]}&limit=100`,
    ]);
  });

  it("a resume with nothing recorded reads at most three pages newest first", async () => {
    const discord = fakeDiscord();
    // Chatter after the meeting keeps every page full and newer than the capture end.
    for (let index = 0; index < 400; index++)
      discord.messages.push(
        discordMessage(
          snowflake(POSTING_STARTS_AT + index),
          { content: "x" },
          USER_ID,
        ),
      );
    await run(discord, history());
    const reads = discord.requests
      .filter((r) => r.method === "GET" && r.path.includes("/messages?"))
      .map((r) => r.path);
    expect(reads).toHaveLength(3);
    expect(reads[0]).toBe(`/channels/${TEXT_CHANNEL_ID}/messages?limit=100`);
    expect(reads[1]).toMatch(/\?before=\d+&limit=100$/);
  });

  it("deliverNotice edits the start message when the row records one", async () => {
    const discord = fakeDiscord();
    await deliverNotice(
      history(),
      PROCESSING_FAILED_NOTICE,
      signal(),
      discord.transport,
    );
    expect(discord.requests).toEqual([
      {
        method: "PATCH",
        path: `/channels/${TEXT_CHANNEL_ID}/messages/${START_MESSAGE_ID}`,
        body: {
          content: PROCESSING_FAILED_NOTICE,
          embeds: [],
          components: [],
          allowed_mentions: { parse: [] },
        },
      },
    ]);
  });

  it("deliverNotice posts a new message when no start message is recorded", async () => {
    const discord = fakeDiscord();
    await deliverNotice(
      history({ startMessageId: undefined }),
      PROCESSING_FAILED_NOTICE,
      signal(),
      discord.transport,
    );
    expect(discord.requests.map((r) => [r.method, r.path])).toEqual([
      ["POST", `/channels/${TEXT_CHANNEL_ID}/messages`],
    ]);
    expect(discord.messages.at(-1)?.content).toBe(PROCESSING_FAILED_NOTICE);
  });
});
