/** @jest-environment node */
import {
  buildLegacyTranscriptPayload,
  buildPlannedWrite,
  mergeSummaryEmbeds,
  parseApprovedPlan,
  serializePlan,
  sha256,
  transcriptKeyBesideAudio,
  type ObservedHistory,
  type PlanInput,
} from "../../scripts/outageMeetingRecoveryPlan";

const history: ObservedHistory = {
  guildId: "100",
  channelId_timestamp: "200#2026-10-28T00:00:00.000Z",
  meetingId: "meeting-1",
  channelId: "200",
  timestamp: "2026-10-28T00:00:00.000Z",
  duration: 600,
  meetingCreatorId: "300",
  processing: { transcription: "partial", notes: "failed", summary: "skipped" },
  notesChannelId: "400",
  textChannelId: "400",
  notesMessageIds: ["500"],
  summaryMessageId: "600",
};

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  table: "prefix-MeetingHistoryTable",
  bucket: "bucket",
  region: "us-east-1",
  history,
  transcription: "partial",
  notes: "## Notes\n- Item",
  summarySentence: "A sentence.",
  summaryLabel: "Label",
  meetingName: "Label",
  generation: { notesModel: "model" },
  now: "2026-10-28T12:00:00.000Z",
  ...overrides,
});

describe("buildPlannedWrite", () => {
  it("writes legacy notes fields guarded on the observed row", () => {
    const plan = buildPlannedWrite(input());
    expect(plan.dynamo.ConditionExpression).toBe(
      "attribute_not_exists(#notesVersion) AND attribute_not_exists(#notes) AND attribute_not_exists(#meetingName) AND #processing.#transcription = :observed_transcription AND #processing.#notes = :observed_notes AND #processing.#summary = :observed_summary",
    );
    expect(plan.dynamo.ExpressionAttributeValues).toMatchObject({
      ":observed_transcription": "partial",
      ":observed_notes": "failed",
      ":observed_summary": "skipped",
      ":processing": {
        transcription: "partial",
        notes: "generated",
        summary: "generated",
      },
      ":notesVersion": 1,
      ":editedBy": "300",
      ":editedAt": "2026-10-28T00:10:00.000Z",
      ":notesHistory": [
        {
          version: 1,
          notes: "## Notes\n- Item",
          editedBy: "300",
          editedAt: "2026-10-28T00:10:00.000Z",
        },
      ],
    });
    expect(plan.dynamo.UpdateExpression).toContain(
      "#meetingName = :meetingName",
    );
    expect(plan.s3).toBeUndefined();
  });

  it("edits notes in place with the legacy embed and no mentions", () => {
    const plan = buildPlannedWrite(input());
    expect(plan.discord.notes).toHaveLength(1);
    const [patch] = plan.discord.notes;
    expect(patch).toMatchObject({ channelId: "400", messageId: "500" });
    expect(patch.body.allowed_mentions).toEqual({ parse: [] });
    expect(patch.body).not.toHaveProperty("components");
    expect(patch.body.embeds[0]).toMatchObject({
      title: "Meeting Notes",
      description: "## Notes\n- Item",
      color: 0x00ae86,
      footer: {
        text: "Some audio could not be transcribed. These notes may be incomplete.",
      },
    });
    expect(plan.discord.summary).toEqual({
      channelId: "400",
      messageId: "600",
      title: "Label",
      description: "A sentence.",
    });
  });

  it("guards a new transcript key and marks a missing summary failed", () => {
    const plan = buildPlannedWrite(
      input({
        history: {
          ...history,
          processing: {
            transcription: "failed",
            notes: "skipped",
            summary: "skipped",
          },
        },
        transcription: "ready",
        summarySentence: undefined,
        summaryLabel: undefined,
        meetingName: undefined,
        transcript: { key: "a/transcript.json", body: "{}" },
      }),
    );
    expect(plan.dynamo.ConditionExpression).toContain(
      "attribute_not_exists(#transcriptS3Key)",
    );
    expect(plan.dynamo.ExpressionAttributeValues[":processing"]).toEqual({
      transcription: "ready",
      notes: "generated",
      summary: "failed",
    });
    expect(plan.s3).toEqual({
      bucket: "bucket",
      key: "a/transcript.json",
      contentType: "application/json",
      body: "{}",
      sha256: sha256("{}"),
    });
    expect(plan.discord.summary?.title).toBe("Meeting Summary");
    expect(plan.discord.summary?.description).toBe("Summary unavailable.");
  });

  it("refuses rows that already have notes", () => {
    expect(() =>
      buildPlannedWrite(input({ history: { ...history, notesVersion: 1 } })),
    ).toThrow("already has notes");
  });

  it("refuses notes that outgrow the existing messages", () => {
    expect(() =>
      buildPlannedWrite(input({ notes: "word ".repeat(4000) })),
    ).toThrow("only 1 exist");
  });
});

describe("parseApprovedPlan", () => {
  it("accepts only the approved bytes", () => {
    const text = serializePlan(buildPlannedWrite(input()));
    expect(parseApprovedPlan(text, sha256(text)).meeting.meetingId).toBe(
      "meeting-1",
    );
    expect(() => parseApprovedPlan(`${text} `, sha256(text))).toThrow(
      "digest mismatch",
    );
  });
});

describe("mergeSummaryEmbeds", () => {
  it("keeps fields and later embeds while swapping title and description", () => {
    const fields = [{ name: "Start Time", value: "x" }];
    expect(
      mergeSummaryEmbeds(
        [{ title: "Old", description: "Summary unavailable.", fields }, {}],
        { title: "New", description: "Done." },
      ),
    ).toEqual([{ title: "New", description: "Done.", fields }, {}]);
    expect(() =>
      mergeSummaryEmbeds([], { title: "t", description: "d" }),
    ).toThrow("no embed");
  });
});

describe("transcript helpers", () => {
  it("places the transcript beside the recording", () => {
    expect(transcriptKeyBesideAudio("g/folder/audio_combined.mp3")).toBe(
      "g/folder/transcript.json",
    );
  });

  it("builds an unattributed legacy payload", () => {
    const payload = buildLegacyTranscriptPayload({
      history,
      text: "hello",
      generatedAt: "now",
    });
    expect(payload).toMatchObject({
      guildId: "100",
      channelId: "200",
      meetingId: "meeting-1",
      text: "hello",
    });
    expect(payload.segments).toEqual([
      expect.objectContaining({ userId: "unattributed", text: "hello" }),
    ]);
  });
});
