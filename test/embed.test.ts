/** @jest-environment node */
jest.mock("../src/services/configService", () => ({
  config: { frontend: { siteUrl: "https://chronote.test" } },
}));
jest.mock("../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: (key: string) => ({
    up: `summary_feedback_up:${key}`,
    down: `summary_feedback_down:${key}`,
  }),
}));
jest.mock("../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename_meeting",
}));
import {
  fixture as updateFixture,
  message as updateMessage,
} from "./services/meetingUpdatePlan.fixture";
import { planMeetingUpdate } from "../src/services/meetingUpdatePlan";
import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { buildSummaryUpgradeBody } from "../src/utils/summaryUpgrade";

import {
  buildMeetingResultMessages,
  presentationFromMeeting,
  type MeetingMessagePayload,
  type SummaryUpgradeOffer,
  updateMeetingProcessingMessage,
} from "../src/embed";
import { DiscordAPIError, EmbedBuilder } from "discord.js";
jest.mock("@langfuse/tracing", () => ({ updateActiveObservation: jest.fn() }));
jest.mock("../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => true,
}));
import type { MeetingData } from "../src/types/meeting-data";

type EmbedPayload = {
  title?: string;
  description?: string;
  footer?: { text: string };
};
type EmbedLike = { toJSON?: () => EmbedPayload; data?: EmbedPayload };
type ButtonRow = { toJSON: () => { components: { label: string }[] } };

const render = (value: unknown, upgrade?: SummaryUpgradeOffer) =>
  buildMeetingResultMessages(
    presentationFromMeeting(value as MeetingData),
    upgrade,
  );
const rows = (payload: MeetingMessagePayload) =>
  payload.components as unknown as ButtonRow[];
const embedJson = (payload: MeetingMessagePayload) =>
  payload.embeds.map((embed) => embed.toJSON());

describe("meeting result messages", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });
  const fixture = () => ({
    meetingId: "meeting-1",
    guildId: "guild-1",
    creator: { id: "user-1" },
    startMessageId: "start",
    startTime: new Date("2025-01-01T00:00:00Z"),
    endTime: new Date("2025-01-01T01:00:00Z"),
    attendance: new Set(),
    voiceChannel: { id: "voice", name: "Voice" },
    textChannel: {
      id: "text",
      messages: {
        fetch: jest.fn().mockResolvedValue({
          id: "start",
          edit: jest.fn().mockResolvedValue(undefined),
        }),
      },
      send: jest.fn(),
    },
    generateNotes: true,
    notesText: "Notes",
    summarySentence: "Summary",
  });
  const denied = () =>
    new DiscordAPIError(
      { code: 50013, message: "PRIVATE ERROR BODY" },
      50013,
      403,
      "POST",
      "https://discord.test/secret",
      { body: { secret: "PRIVATE REQUEST" }, files: [] },
    );

  it("notes_actions_preserve_delivery on the summary and final multipart batch without a new capture", () => {
    const value = fixture();
    value.notesText = "A".repeat(11800);
    const { summary, notes } = render(value);
    const expectedActions = [
      expect.objectContaining({
        label: "Open meeting",
        style: 5,
        url: "https://chronote.test/portal/meetings/guild-1/voice%232025-01-01T00%3A00%3A00.000Z?fullScreen=true",
      }),
      expect.objectContaining({
        label: "Optional setup",
        style: 5,
        url: "https://chronote.test/join?serverId=guild-1#optional-setup",
      }),
    ];
    expect(notes).toHaveLength(3);
    expect(rows(summary)[0].toJSON().components).toEqual(expectedActions);
    expect(rows(notes.at(-1)!)[0].toJSON().components).toEqual(expectedActions);
    expect(
      notes.slice(0, -1).every((payload) => payload.components.length === 0),
    ).toBe(true);
    expect(
      rows(summary).flatMap((row) =>
        row.toJSON().components.map((button) => button.label),
      ),
    ).toEqual([
      "Open meeting",
      "Optional setup",
      "Helpful",
      "Needs work",
      "Suggest correction",
      "Rename meeting",
      "Edit tags",
    ]);
    for (const payload of [summary, ...notes]) {
      expect(payload.components.length).toBeLessThanOrEqual(5);
      for (const row of rows(payload))
        expect(row.toJSON().components.length).toBeLessThanOrEqual(5);
    }
  });

  it.each([1, 2])(
    "shrinks actual Upgrade notes to %i pages while retaining final controls",
    (pages) => {
      const value = fixture();
      value.notesText = "A".repeat(11800);
      const { notes } = render(value, {
        url: "https://chronote.test/upgrade",
        recordedSeconds: 5400,
      });
      const input = updateFixture(
        "Old",
        pages === 1 ? "Short" : "B".repeat(4500),
      );
      const posts = notes.map((payload, index) => {
        const embeds: EmbedBuilder[] = payload.embeds;
        const buttonRows =
          payload.components as ActionRowBuilder<ButtonBuilder>[];
        return {
          ...updateMessage(
            String(100 + index),
            embeds.map((embed) => ({ ...embed.toJSON() })),
          ),
          components: buttonRows.map((row) => ({ ...row.toJSON() })),
        };
      });
      expect(posts).toHaveLength(3);
      input.history.notesMessageIds = posts.map((post) => post.id);
      input.messages = [...posts, input.messages.at(-1)!];
      const result = planMeetingUpdate(input);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready")
        throw new Error("Actual live notes must be editable");
      const surviving = result.targets.filter((target) =>
        posts.some((post) => post.id === target.messageId),
      );
      expect(surviving.map((target) => target.messageId)).toEqual(
        pages === 1 ? ["102"] : ["100", "102"],
      );
      expect(surviving.at(-1)?.after.components).toEqual(posts[2].components);
      const fields = surviving.flatMap((target) =>
        target.after.embeds.flatMap((embed) => embed.fields ?? []),
      );
      expect(fields).toEqual([
        {
          name: "Need more recording time?",
          value: buildSummaryUpgradeBody(5400),
        },
      ]);
      expect(surviving.at(-1)?.after.embeds.at(-1)).toHaveProperty(
        "fields",
        fields,
      );
      expect(
        result.attempt.operations.map((operation) => operation.kind),
      ).toEqual(
        pages === 1
          ? ["patch", "register", "delete", "delete"]
          : ["patch", "patch", "register", "delete"],
      );
      expect(
        result.attempt.operations.find(
          (operation) => operation.kind === "register",
        ),
      ).toMatchObject({
        expectedPointers: { notesMessageIds: ["100", "101", "102"] },
        slots: (pages === 1 ? ["102"] : ["100", "102"]).map((messageId) => ({
          kind: "existing",
          messageId,
        })),
      });
      expect(
        result.payloads.every((entry) => !("components" in entry.payload)),
      ).toBe(true);
    },
  );

  it("adds the value proposition and Upgrade beside Open meeting", () => {
    const value = fixture();
    const url =
      "https://chronote.test/upgrade/select-server?serverId=guild-1&plan=basic";
    const { summary, notes } = render(value, { url, recordedSeconds: 5400 });
    expect(embedJson(summary)[0]).toHaveProperty(
      "fields",
      expect.arrayContaining([
        {
          name: "Need more recording time?",
          value: buildSummaryUpgradeBody(5400),
        },
      ]),
    );
    expect(rows(summary)[0].toJSON().components).toEqual([
      expect.objectContaining({ label: "Open meeting" }),
      expect.objectContaining({
        label: "Optional setup",
        url: "https://chronote.test/join?serverId=guild-1#optional-setup",
        style: 5,
      }),
      expect.objectContaining({ label: "Upgrade", url, style: 5 }),
    ]);
    expect(embedJson(notes[0])[0]).toHaveProperty(
      "fields",
      expect.arrayContaining([
        {
          name: "Need more recording time?",
          value: buildSummaryUpgradeBody(5400),
        },
      ]),
    );
    expect(rows(notes[0])[0].toJSON().components).toEqual([
      expect.objectContaining({ label: "Open meeting", style: 5 }),
      expect.objectContaining({ label: "Optional setup", style: 5 }),
      expect.objectContaining({
        label: "Upgrade",
        url: `${url}&source=discord_notes`,
        style: 5,
      }),
    ]);
    expect(value.notesText).toBe("Notes");
  });

  it("adds the offer only to the final notes chunk while respecting Discord text limits", () => {
    const value = fixture();
    value.notesText = "A".repeat(11800);
    const url =
      "https://chronote.test/upgrade/select-server?serverId=guild-1&plan=basic";
    const { notes: payloads } = render(value, { url, recordedSeconds: 3600 });
    expect(payloads.length).toBeGreaterThan(1);
    for (const payload of payloads) {
      const length = embedJson(payload).reduce(
        (total, embed) =>
          total +
          (embed.title?.length ?? 0) +
          (embed.description?.length ?? 0) +
          (embed.fields?.reduce(
            (count, field) => count + field.name.length + field.value.length,
            0,
          ) ?? 0),
        0,
      );
      expect(length).toBeLessThanOrEqual(6000);
    }
    expect(
      payloads
        .slice(0, -1)
        .every(
          (payload) =>
            payload.components.length === 0 &&
            embedJson(payload).every((embed) => !embed.fields?.length),
        ),
    ).toBe(true);
    expect(embedJson(payloads.at(-1)!).at(-1)?.fields?.[0].value).toBe(
      buildSummaryUpgradeBody(3600),
    );
    expect(rows(payloads.at(-1)!)[0].toJSON().components).toContainEqual(
      expect.objectContaining({
        label: "Upgrade",
        url: `${url}&source=discord_notes`,
      }),
    );
    expect(value.notesText).toBe("A".repeat(11800));
  });

  it("reports total processing failure without throwing or exposing arbitrary errors", async () => {
    const value = fixture();
    value.textChannel.messages.fetch.mockRejectedValue(
      new Error("PRIVATE FETCH"),
    );
    value.textChannel.send.mockRejectedValue(denied());
    await expect(
      updateMeetingProcessingMessage(value as unknown as MeetingData),
    ).resolves.toMatchObject({ outcome: "failed", intended: 1, sent: 0 });
  });

  it("reports a successful fallback with sanitized evidence of the failed edit", async () => {
    const value = fixture();
    value.textChannel.messages.fetch.mockRejectedValue(denied());
    value.textChannel.send.mockResolvedValue({ id: "replacement" });
    await expect(
      updateMeetingProcessingMessage(value as unknown as MeetingData),
    ).resolves.toEqual({
      outcome: "sent_fallback",
      intended: 1,
      sent: 1,
      errors: [{ code: 50013, status: 403 }],
    });
  });

  it("renders the summary and the notes content", () => {
    const value = {
      ...fixture(),
      attendance: new Set(["User One"]),
      notesText: "Notes content.",
      summarySentence: "Summary text.",
      tags: ["tag-1"],
    };
    const { summary, notes } = render(value);
    expect(summary.embeds).toHaveLength(1);
    expect(embedJson(summary)[0].description).toContain("Summary text.");
    expect(notes).toHaveLength(1);
    expect(embedJson(notes[0])[0].description).toContain("Notes content.");
  });

  it("handles empty notes text by posting a fallback embed", () => {
    const value = fixture();
    value.notesText = "   ";
    const { notes } = render(value);
    expect(notes[0].embeds).toHaveLength(1);
    expect(embedJson(notes[0])[0].description).toContain("Notes unavailable.");
  });

  it("posts classified empty and partial notices outside notes text", () => {
    const empty = {
      ...fixture(),
      notesText: "",
      processing: { transcription: "empty", notes: "skipped" },
    };
    expect(embedJson(render(empty).notes[0])[0].description).toBe(
      "No usable speech was found, so no notes were generated.",
    );

    const partial = {
      ...fixture(),
      notesText: "Stored notes stay unchanged.",
      processing: { transcription: "partial", notes: "generated" },
    };
    const partialEmbed = embedJson(render(partial).notes[0])[0];
    expect(partialEmbed.description).toBe("Stored notes stay unchanged.");
    expect(partialEmbed.footer?.text).toBe(
      "Some audio could not be transcribed. These notes may be incomplete.",
    );
    expect(partial.notesText).toBe("Stored notes stay unchanged.");
  });

  it("batches partial notes within Discord's aggregate embed text limit", () => {
    const partial = {
      ...fixture(),
      notesText: "A".repeat(5900),
      processing: { transcription: "partial", notes: "generated" },
    };
    const { notes } = render(partial);
    expect(notes).toHaveLength(2);
    for (const payload of notes) {
      const embeds = (payload.embeds as EmbedLike[]).map(
        (embed) => embed.toJSON?.() ?? embed.data ?? {},
      );
      const totalText = embeds.reduce(
        (total: number, embed: EmbedPayload) =>
          total +
          (embed.title?.length ?? 0) +
          (embed.description?.length ?? 0) +
          (embed.footer?.text.length ?? 0),
        0,
      );
      expect(totalText).toBeLessThanOrEqual(6000);
      expect(embeds[0].footer?.text).toContain(
        "Some audio could not be transcribed. These notes may be incomplete.",
      );
    }
  });

  it("chunks long notes across multiple embeds", () => {
    const longNotes = "A".repeat(9000);
    const { notes } = render({ ...fixture(), notesText: longNotes });
    expect(notes).toHaveLength(2);
    const descriptions = notes.flatMap((payload) =>
      embedJson(payload).map((embed) => embed.description ?? ""),
    );
    expect(descriptions.join("").length).toBe(longNotes.length);
  });
});
