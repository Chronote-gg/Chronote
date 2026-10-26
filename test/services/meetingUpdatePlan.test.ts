/** @jest-environment node */
import { titleOnlyFixture } from "./meetingUpdatePlan.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { fixture } from "./meetingUpdatePlan.fixture";
import {
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
} from "../../src/types/meetingUpdateDelivery";
import { PARTIAL_TRANSCRIPT_NOTICE } from "../../src/utils/meetingProcessing";

function ready(input = fixture()) {
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("Expected complete plan");
  expect(
    preparedMeetingUpdateAttemptSchema.safeParse(result.attempt).success,
  ).toBe(true);
  return result;
}

describe("scoped meeting update planning", () => {
  it("preserves a differing untouched summary and protected message fields in a notes-only edit", () => {
    const input = fixture();
    const before = input.messages[0];
    before.content = "Keep link https://example.test";
    before.components = [
      {
        type: 1,
        components: [
          { type: 2, custom_id: "synthetic-control", label: "Keep", style: 1 },
        ],
      },
    ];
    before.attachments = [{ id: "999997", filename: "synthetic.txt", size: 5 }];
    before.embeds[0] = {
      ...before.embeds[0],
      color: 456,
      timestamp: "2026-10-22T00:00:00.000Z",
    };
    before.embeds.push({
      title: "Unrelated",
      description: "Keep whitespace  \n",
    });
    const original = structuredClone(input);
    const result = ready(input);
    const target = result.targets.find((item) => item.messageId === before.id)!;
    expect(
      result.targets.find(
        (item) => item.messageId === input.history.summaryMessageId,
      )?.after,
    ).toEqual(original.messages[1]);
    expect(target.after.embeds[0]).toMatchObject({
      description: "Edited notes",
      color: 456,
      timestamp: "2026-10-22T00:00:00.000Z",
    });
    expect(target.after.embeds[1]).toEqual(before.embeds[1]);
    expect(target.after.components).toEqual(before.components);
    expect(target.after.content).toBe(before.content);
    expect(target.after.attachments).toEqual(before.attachments);
    const outgoing = result.payloads.find((item) => item.kind === "patch")!;
    expect(outgoing.payload).toEqual({
      embeds: target.after.embeds,
      allowed_mentions: { parse: [] },
    });
    for (const key of ["content", "components", "attachments", "flags"])
      expect(outgoing.payload).not.toHaveProperty(key);
    expect(input).toEqual(original);
    expect(result.attempt.capturedParts).toEqual({ notesBody: 1 });
  });

  it("captures pending rename parts together with a newer notes body", () => {
    const input = fixture();
    input.history.contentRevision = 2;
    input.history.meetingName = "New title";
    input.history.updateDelivery = meetingUpdateDeliverySchema.parse({
      ...input.history.updateDelivery,
      parts: {
        ...input.history.updateDelivery.parts,
        notesBody: { desired: 2, acknowledged: 0 },
        notesTitle: { desired: 1, acknowledged: 0 },
        summaryTitle: { desired: 1, acknowledged: 0 },
      },
    });
    const result = ready(input);
    expect(result.attempt.capturedParts).toEqual({
      notesBody: 2,
      notesTitle: 1,
      summaryTitle: 1,
    });
    expect(result.targets[0].after.embeds[0]).toMatchObject({
      title: "New title",
      description: "Edited notes",
    });
    expect(result.targets[1].after.embeds[0]).toMatchObject({
      title: "New title",
      description: "Manually different summary",
    });
  });

  it("keeps notes and summary bodies unchanged for title-only work", () => {
    const input = titleOnlyFixture("New title");
    const result = ready(input);
    expect(result.targets[0].after.embeds[0]).toMatchObject({
      title: "New title",
      description: "Old notes",
      footer: { text: "v1" },
    });
    expect(result.targets[1].after.embeds[0].description).toBe(
      "Manually different summary",
    );
  });

  it("uses shared warnings only for requested summary presentation", () => {
    const input = fixture();
    input.history.processing = { transcription: "partial" };
    input.history.updateDelivery.parts.summaryWarning = {
      desired: 1,
      acknowledged: 0,
    };
    const result = ready(input);
    expect(result.targets[0].after.embeds[0].footer).toEqual({
      text: "v2 • " + PARTIAL_TRANSCRIPT_NOTICE,
    });
    expect(result.targets[1].after.embeds[0].description).toBe(
      PARTIAL_TRANSCRIPT_NOTICE + "\n\nManually different summary",
    );
    expect(result.attempt.capturedParts).toEqual({
      notesBody: 1,
      summaryWarning: 1,
    });
  });

  it("supports multiple notes embeds per post and preserves unrelated slots", () => {
    const input = fixture("x".repeat(4500), "y".repeat(4500));
    input.messages[0].embeds.splice(1, 0, {
      title: "Unrelated",
      description: "Keep",
    });
    const result = ready(input);
    expect(
      result.targets[0].after.embeds.map((embed) => embed.description),
    ).toEqual(["y".repeat(4096), "Keep", "y".repeat(404)]);
    expect(result.attempt.operations.map((op) => op.kind)).toEqual(["patch"]);
  });

  it("reuses surviving IDs on growth and registers additions after POST", () => {
    const input = fixture("Old", "x".repeat(9000));
    const result = ready(input);
    expect(result.attempt.operations.map((op) => op.kind)).toEqual([
      "patch",
      "post",
      "register",
    ]);
    const register = result.attempt.operations.at(-1)!;
    expect(register).toMatchObject({
      kind: "register",
      expectedPointers: {
        notesChannelId: input.history.notesChannelId,
        notesMessageIds: input.history.notesMessageIds,
      },
      slots: [
        { kind: "existing", messageId: input.messages[0].id },
        {
          kind: "created",
          operationId: result.attempt.operations[1].operationId,
        },
      ],
    });
    expect(
      result.payloads.find((item) => item.kind === "post")?.payload,
    ).toHaveProperty("allowed_mentions", { parse: [] });
  });

  it("registers shorter pointers before removing an obsolete notes-only post", () => {
    const input = fixture("x".repeat(9000), "Short");
    const result = ready(input);
    expect(result.attempt.operations.map((op) => op.kind)).toEqual([
      "patch",
      "register",
      "delete",
    ]);
    expect(result.attempt.operations.at(-1)).toMatchObject({
      kind: "delete",
      messageId: input.messages[1].id,
    });
  });

  it.each(["content", "components", "attachments", "unrelated"])(
    "retains the protected final post with %s",
    (surface) => {
      const input = fixture("x".repeat(9000), "Short");
      const surplus = input.messages[1];
      if (surface === "content") surplus.content = "Keep";
      if (surface === "components") surplus.components = [{ type: 1 }];
      if (surface === "attachments") surplus.attachments = [{ id: "999997" }];
      if (surface === "unrelated")
        surplus.embeds.push({ title: "Unrelated", description: "Keep" });
      const result = ready(input);
      expect(result.targets[0].messageId).toBe(surplus.id);
      expect(result.targets[0].after).toMatchObject({
        content: surplus.content,
        components: surplus.components,
        attachments: surplus.attachments,
        flags: surplus.flags,
      });
      expect(
        result.attempt.operations.find(
          (operation) => operation.kind === "delete",
        ),
      ).toMatchObject({ messageId: input.messages[0].id });
      input.messages[0].content = "Also protected";
      expect(planMeetingUpdate(input)).toMatchObject({
        kind: "blocked",
        reason: "protected_surplus",
      });
    },
  );

  it.each([
    "missing",
    "aliased",
    "webhook",
    "components-v2",
    "unknown-embed",
    "pagination",
    "aggregate",
  ])(
    "preflights the complete %s layout before returning any mutations",
    (problem) => {
      const input = fixture();
      if (problem === "missing") input.messages.shift();
      if (problem === "aliased")
        input.history.summaryMessageId = input.messages[0].id;
      if (problem === "webhook") input.messages[0].webhook_id = "999997";
      if (problem === "components-v2") input.messages[0].flags = 32768;
      if (problem === "unknown-embed")
        input.messages[0].embeds[0].unknown_visible_field = "unsafe";
      if (problem === "pagination")
        input.messages[0].embeds[0].title = "Meeting Notes (part 2/3)";
      if (problem === "aggregate") input.history.notes = "e".repeat(2000);
      if (problem === "aggregate")
        input.messages[0].embeds.push({
          description: "x".repeat(4096),
          fields: [{ name: "Extra", value: "z".repeat(1024) }],
        });
      const result = planMeetingUpdate(input);
      expect(result.kind).toBe("blocked");
      expect(result).not.toHaveProperty("attempt");
      expect(result).not.toHaveProperty("payloads");
    },
  );

  it("skips matching messages with explicit immutable observation evidence", () => {
    const input = fixture("Edited notes", "Edited notes");
    input.messages[0].embeds[0].footer = { text: "v2" };
    const result = ready(input);
    expect(result.attempt.operations).toEqual([]);
    expect(result.payloads).toEqual([]);
    expect(result.attempt.observations).toContainEqual(
      expect.objectContaining({
        messageId: input.messages[0].id,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(result.attempt.capturedParts).toEqual({ notesBody: 1 });
  });
});

it("updates initially published notes with no version footer", () => {
  const input = fixture();
  delete input.messages[0].embeds[0].footer;
  const result = ready(input);
  expect(result.targets[0].after.embeds[0].footer).toEqual({ text: "v2" });
});

it("preserves the current title during a body edit and updates imported notes", () => {
  const input = fixture();
  input.history.meetingName = "Canonical name not requested";
  input.messages[0].embeds[0].title = "Existing title";
  input.messages[0].embeds[0].footer = {
    text: "v1 - Imported by Synthetic Editor",
  };
  const result = ready(input);
  expect(result.targets[0].after.embeds[0]).toMatchObject({
    title: "Existing title",
    description: "Edited notes",
    footer: { text: "v2" },
  });
  expect(result.attempt.capturedParts).toEqual({ notesBody: 1 });
});

it("renames an initial notes post without inventing an empty footer", () => {
  const input = fixture();
  delete input.messages[0].embeds[0].footer;
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.notesTitle = {
    desired: 1,
    acknowledged: 0,
  };
  input.history.meetingName = "Renamed";
  const result = ready(input);
  expect(result.targets[0].after.embeds[0]).toMatchObject({
    title: "Renamed",
    description: "Old notes",
  });
  expect(result.targets[0].after.embeds[0]).not.toHaveProperty("footer");
});

it("carries validated notes color and timestamp into added pages", () => {
  const input = fixture("Old", "n".repeat(9000));
  input.messages[0].embeds[0].color = 123456;
  input.messages[0].embeds[0].timestamp = "2026-10-22T00:00:00.000Z";
  const result = ready(input);
  const added = result.payloads.find((item) => item.kind === "post")!;
  for (const embed of added.payload.embeds)
    expect(embed).toMatchObject({
      color: 123456,
      timestamp: "2026-10-22T00:00:00.000Z",
    });
});
