/** @jest-environment node */
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { recoveredFixture } from "./recoveredMeetingLayout.fixture";
import { PARTIAL_TRANSCRIPT_NOTICE } from "../../src/utils/meetingProcessing";
import { observedMeetingUpdateCreationFingerprint } from "../../src/services/meetingUpdateFingerprint";

function renameFixture(options: Parameters<typeof recoveredFixture>[0] = {}) {
  const input = recoveredFixture(options);
  input.history.meetingName = "Renamed meeting";
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.notesTitle = {
    desired: 1,
    acknowledged: 0,
  };
  return input;
}

describe("registered recovered message layouts", () => {
  it.each([true, false])(
    "blocks mixed recovered page titles across registered messages, linked=%s",
    (linked) => {
      const input = renameFixture({
        linked,
        beforeNotes: "Saved discussion. ".repeat(700),
      });
      expect(input.history.notesMessageIds.length).toBeGreaterThan(2);
      input.messages[1].embeds[0].title = `Unrelated info (part 2/${input.history.notesMessageIds.length})`;
      expect(planMeetingUpdate(input).kind).toBe("blocked");
    },
  );
  it.each([
    { linked: true, extraLinked: false },
    { linked: false, extraLinked: false },
    { linked: true, extraLinked: true },
  ])(
    "blocks ambiguous renamed pages, linked=$linked extraLinked=$extraLinked",
    ({ linked, extraLinked }) => {
      const input = renameFixture({ linked });
      input.messages[0].embeds[0].title = "Recovered partial notes (part 1/2)";
      input.messages[0].embeds.push({
        title: "Unrelated info (part 2/2)",
        description: "Keep this content",
        ...(extraLinked ? { url: input.messages[0].embeds[0].url } : {}),
      });
      expect(planMeetingUpdate(input).kind).toBe("blocked");
    },
  );

  it("renames only the linked notes slot while preserving an unrelated plain embed", () => {
    const input = renameFixture();
    const unrelated = {
      title: "Unrelated info",
      description: "Keep this content",
    };
    input.messages[0].embeds.push(unrelated);
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected scoped rename");
    expect(
      result.targets.find((target) => target.messageId === input.messages[0].id)
        ?.after.embeds[1],
    ).toEqual(unrelated);
  });

  it.each([true, false])(
    "edits compact recovered notes and summary while retaining links and warnings, linked=%s",
    (linked) => {
      const input = recoveredFixture({ linked });
      const before = structuredClone(input);
      const result = planMeetingUpdate(input);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready")
        throw new Error("Expected recovered layout plan");
      const target = result.targets.find(
        (value) => value.messageId === input.history.notesMessageIds[0],
      );
      expect(target?.after.embeds[0]).toMatchObject({
        title: "Recovered partial notes",
        color: 123,
        timestamp: input.history.timestamp,
      });
      expect(target?.after.embeds[0].description).toContain("Edited notes");
      expect(target?.after.embeds[0].footer).toMatchObject({
        text: expect.stringContaining(PARTIAL_TRANSCRIPT_NOTICE),
      });
      expect(target?.after.embeds[0].url).toBe(
        before.messages[0].embeds[0].url,
      );
      expect(
        result.targets.find(
          (value) => value.messageId === input.history.summaryMessageId,
        )?.after,
      ).toEqual(before.messages[1]);
      expect(input).toEqual(before);
    },
  );

  const invalid: {
    name: string;
    change(input: ReturnType<typeof recoveredFixture>): void;
  }[] = [
    {
      name: "unrelated notes URL",
      change: (input) => {
        input.messages[0].embeds[0].url = "https://example.test/unrelated";
      },
    },
    {
      name: "unrelated summary URL",
      change: (input) => {
        input.messages[1].embeds[0].url = "https://example.test/unrelated";
      },
    },
    {
      name: "another guild",
      change: (input) => {
        input.channels[0].guild_id = "999";
      },
    },
    {
      name: "another author",
      change: (input) => {
        input.messages[0].author.id = "999";
      },
    },
    {
      name: "webhook ownership",
      change: (input) => {
        input.messages[0].webhook_id = "999";
      },
    },
    {
      name: "aliased summary pointer",
      change: (input) => {
        input.history.summaryMessageId = input.history.notesMessageIds[0];
      },
    },
    {
      name: "missing registered pointer",
      change: (input) => {
        input.history.notesMessageIds = ["999"];
      },
    },
    {
      name: "unfinished recovery",
      change: (input) => {
        input.history.recovery = {
          disposition: "claimed",
          stage: "notes",
          attempt: 1,
          executionVersion: 2,
          retry: { maxAttempts: 4, nextAttemptAt: null },
        };
      },
    },
    {
      name: "unfinished capture",
      change: (input) => {
        input.history.capture = {
          kind: "capturing",
          startedAt: input.history.timestamp,
        };
      },
    },
    {
      name: "different checkpoint meeting",
      change: (input) => {
        if (input.history.checkpoint)
          input.history.checkpoint.capture.meetingId = "other";
      },
    },
    {
      name: "different checkpoint guild",
      change: (input) => {
        if (input.history.checkpoint)
          input.history.checkpoint.capture.guildId = "other";
      },
    },
    {
      name: "different transcript checkpoint revision",
      change: (input) => {
        if (input.history.recoveryTranscript)
          input.history.recoveryTranscript.checkpointRevision++;
      },
    },
    {
      name: "different transcript folder",
      change: (input) => {
        if (input.history.recoveryTranscript)
          input.history.recoveryTranscript.object.key =
            "other/recovery/transcript.json";
      },
    },
    {
      name: "invalid transcript checksum",
      change: (input) => {
        if (input.history.recoveryTranscript)
          input.history.recoveryTranscript.object.checksumSha256 = "invalid";
      },
    },
    {
      name: "missing original transcript receipt",
      change: (input) => {
        delete input.history.recoveryTranscript;
      },
    },
    {
      name: "unacknowledged delivery",
      change: (input) => {
        if (input.history.delivery?.notes)
          input.history.delivery.notes.sent = 0;
      },
    },
    {
      name: "summary inside notes message",
      change: (input) => {
        input.messages[0].embeds.push({
          title: "Summary",
          description: "Other",
          fields: [
            { name: "Start time", value: "12:00" },
            { name: "Duration", value: "60" },
          ],
        });
      },
    },
    {
      name: "image notes",
      change: (input) => {
        input.messages[0].embeds[0].image = {
          url: "https://example.test/image.png",
        };
      },
    },
    {
      name: "ambiguous compact summary",
      change: (input) => {
        input.messages[1].embeds.push({
          title: "Another",
          description: "Other",
        });
      },
    },
  ];
  it.each(invalid)("blocks $name", ({ change }) => {
    const input = recoveredFixture();
    change(input);
    expect(planMeetingUpdate(input).kind).toBe("blocked");
  });

  it("preserves supported unrelated message metadata without taking cleanup ownership", () => {
    const input = recoveredFixture();
    input.messages[0].content = "Keep this message text";
    input.messages[0].components = [{ type: 1 }];
    input.messages[0].attachments = [{ id: "999998" }];
    input.messages[0].embeds.push({
      title: "Unrelated",
      description: "Keep this embed",
      url: "https://example.test/keep",
    });
    const before = structuredClone(input.messages[0]);
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") throw new Error("Expected scoped patch");
    const after = result.targets.find(
      (target) => target.messageId === before.id,
    )?.after;
    expect(after?.content).toBe(before.content);
    expect(after?.components).toEqual(before.components);
    expect(after?.attachments).toEqual(before.attachments);
    expect(after?.embeds[1]).toEqual(before.embeds[1]);
  });

  it("does not grant the recovered route to an unregistered cleanup candidate", () => {
    const input = recoveredFixture();
    const retained = { ...structuredClone(input.messages[0]), id: "999997" };
    input.messages.push(retained);
    input.history.updateDelivery.createdCandidates.push({
      operationId: "old-post",
      channelId: retained.channel_id,
      messageId: retained.id,
      fingerprint: observedMeetingUpdateCreationFingerprint(retained),
    });
    expect(planMeetingUpdate(input).kind).toBe("blocked");
  });

  it.each([true, false])(
    "supports the complete-capture recovery builder, linked=%s",
    (linked) => {
      const input = recoveredFixture({ linked, complete: true });
      const result = planMeetingUpdate(input);
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready")
        throw new Error("Expected recovered layout plan");
      const notes = result.targets.find(
        (target) => target.messageId === input.history.notesMessageIds[0],
      );
      expect(notes?.after.embeds[0].description).toBe("Edited notes");
      expect(notes?.after.embeds[0].title).toBe("Recovered meeting notes");
      expect(notes?.after.embeds[0].url).toBe(input.messages[0].embeds[0].url);
    },
  );

  it("recognizes multi-message pages produced by the recovery builder", () => {
    const input = recoveredFixture({
      beforeNotes: "Saved discussion. ".repeat(700),
    });
    expect(input.history.notesMessageIds.length).toBeGreaterThan(1);
    expect(planMeetingUpdate(input).kind).toBe("ready");
    input.messages[0].embeds[0].title = "Recovered partial notes (part 2/99)";
    expect(planMeetingUpdate(input).kind).toBe("blocked");
  });
});
