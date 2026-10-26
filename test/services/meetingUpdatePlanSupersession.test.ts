/** @jest-environment node */
import { fixture, titleOnlyFixture } from "./meetingUpdatePlan.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";

function applyFirstNotesPatch(input: ReturnType<typeof fixture>) {
  const original = planMeetingUpdate(input);
  expect(original.kind).toBe("ready");
  if (original.kind !== "ready") throw new Error("Expected initial plan");
  const patch = original.attempt.operations.find(
    (operation) =>
      operation.kind === "patch" &&
      operation.messageId === input.history.notesMessageIds[0],
  );
  if (!patch) throw new Error("Expected notes PATCH");
  const payload = original.payloads.find(
    (item) => item.operationId === patch.operationId,
  );
  if (!payload) throw new Error("Expected local payload");
  input.messages[0].embeds = structuredClone(payload.payload.embeds);
  input.history.contentRevision = 2;
  input.history.notesVersion = 3;
  return input;
}
it.each(["shrink", "growth", "footerless-shrink"])(
  "replans after a settled pre-registration %s PATCH and newer save",
  (kind) => {
    const input = fixture(
      "x".repeat(7000),
      kind === "growth" ? "y".repeat(10000) : "Small",
    );
    if (kind === "footerless-shrink")
      for (const message of input.messages.slice(0, -1))
        delete message.embeds[0].footer;
    const priorPointers = [...input.history.notesMessageIds];
    applyFirstNotesPatch(input);
    input.history.notes = "z".repeat(kind === "growth" ? 11000 : 40);
    input.history.updateDelivery.parts.notesBody.desired = 2;
    const latest = planMeetingUpdate(input);
    expect(latest.kind).toBe("ready");
    if (latest.kind !== "ready") return;
    expect(latest.attempt.expectedPointers.notesMessageIds).toEqual(
      priorPointers,
    );
    expect(latest.attempt.capturedParts).toEqual({ notesBody: 2 });
    expect(latest.targets[0].after.embeds[0].description).toBe(
      input.history.notes.slice(0, 4096),
    );
  },
);
it("replans a partially applied rename with mixed old/new title bases", () => {
  const input = titleOnlyFixture("First rename", "x".repeat(7000));
  applyFirstNotesPatch(input);
  input.history.meetingName = "Latest rename";
  input.history.updateDelivery.parts.notesTitle.desired = 2;
  input.history.updateDelivery.parts.summaryTitle.desired = 2;
  const latest = planMeetingUpdate(input);
  expect(latest.kind).toBe("ready");
  if (latest.kind !== "ready") return;
  expect(latest.targets[0].after.embeds[0].title).toBe(
    "Latest rename (part 1/2)",
  );
  expect(latest.targets[1].after.embeds[0].title).toBe(
    "Latest rename (part 2/2)",
  );
  expect(latest.targets[0].after.embeds[0].description).toBe("x".repeat(4096));
});
it("renames one unambiguous footerless named initial slot without touching unrelated media", () => {
  const input = fixture();
  input.messages[0].embeds[0].title = "Old name";
  delete input.messages[0].embeds[0].footer;
  const media = { image: { url: "https://example.test/unrelated.png" } };
  input.messages[0].embeds.push(media);
  input.history.meetingName = "New name";
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.notesTitle = {
    desired: 1,
    acknowledged: 0,
  };
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[0].after.embeds[0]).toMatchObject({
    title: "New name",
    description: "Old notes",
  });
  expect(result.targets[0].after.embeds[1]).toEqual(media);
});
it("holds an ambiguous footerless rename and reversed recorded pagination", () => {
  const ambiguous = fixture();
  ambiguous.history.meetingName = "New name";
  ambiguous.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  ambiguous.history.updateDelivery.parts.notesTitle = {
    desired: 1,
    acknowledged: 0,
  };
  ambiguous.messages[0].embeds = [
    { title: "Old name", description: "Notes" },
    { title: "Unrelated", description: "Keep" },
  ];
  expect(planMeetingUpdate(ambiguous).kind).toBe("blocked");
  const reversed = fixture("x".repeat(7000), "Small");
  reversed.history.notesMessageIds.reverse();
  expect(planMeetingUpdate(reversed).kind).toBe("blocked");
});
it("reflows a formerly batched post when new full pages no longer fit together", () => {
  const input = fixture("x".repeat(4500), "y".repeat(9000));
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.attempt.operations.map((operation) => operation.kind)).toEqual([
    "patch",
    "post",
    "register",
  ]);
  expect(result.targets[0].after.embeds).toHaveLength(1);
  expect(result.targets[0].after.embeds[0].description).toBe("y".repeat(4096));
  expect(
    result.payloads.find((payload) => payload.kind === "post")?.payload.embeds,
  ).toHaveLength(2);
});

it("replans across a removed batched slot and an older remaining page ordinal gap", () => {
  const before =
    "x".repeat(2500) + "\n" + "y".repeat(2500) + "\n" + "z".repeat(4000);
  const input = fixture(before, "Small");
  expect(input.messages[0].embeds).toHaveLength(2);
  applyFirstNotesPatch(input);
  expect(input.messages[0].embeds).toHaveLength(1);
  expect(input.messages[1].embeds[0].title).toBe("Meeting Notes (part 3/3)");
  input.history.notes = "Newest";
  input.history.updateDelivery.parts.notesBody.desired = 2;
  const latest = planMeetingUpdate(input);
  expect(latest.kind).toBe("ready");
  if (latest.kind !== "ready") return;
  expect(latest.attempt.operations.map((operation) => operation.kind)).toEqual([
    "patch",
    "register",
    "delete",
  ]);
  expect(latest.targets[0].after.embeds[0].description).toBe("Newest");
});
it("preserves unrelated embeds and the surviving ID while reflowing a full batched post", () => {
  const input = fixture("x".repeat(4500), "y".repeat(9000));
  const unrelated = { title: "Unrelated", description: "Keep" };
  input.messages[0].embeds.splice(1, 0, unrelated);
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[0].after.embeds).toEqual([
    expect.objectContaining({ description: "y".repeat(4096) }),
    unrelated,
  ]);
  const register = result.attempt.operations.find(
    (operation) => operation.kind === "register",
  );
  expect(register).toMatchObject({
    slots: [
      { kind: "existing", messageId: input.messages[0].id },
      { kind: "created", operationId: expect.any(String) },
    ],
  });
});
