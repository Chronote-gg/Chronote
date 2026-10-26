/** @jest-environment node */
import { fixture } from "./meetingUpdatePlan.fixture";
import {
  planMeetingUpdate,
  meetingUpdateMessageFingerprint,
} from "../../src/services/meetingUpdatePlan";
import {
  buildSummaryUpgradeBody,
  SUMMARY_UPGRADE,
} from "../../src/utils/summaryUpgrade";
import { isNotesEmbed } from "../../src/services/discordEmbedLayout";

const field = {
  name: SUMMARY_UPGRADE.heading,
  value: buildSummaryUpgradeBody(5400),
};
function ready(input: ReturnType<typeof fixture>) {
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") throw new Error("Expected editable notes");
  return result;
}
test("moves the exact offer on growth and within-post shrink without changing fingerprints' field authority", () => {
  const input = fixture("Old", "N".repeat(9000));
  input.messages[0].embeds[0].fields = [field];
  input.messages[0].components = [{ type: 1 }];
  const before = meetingUpdateMessageFingerprint(input.messages[0]);
  const result = ready(input);
  const notes = result.payloads.flatMap((payload) => payload.payload.embeds);
  expect(notes.flatMap((embed) => embed.fields ?? [])).toEqual([field]);
  expect(notes.at(-1)).toHaveProperty("fields", [field]);
  expect(result.targets[0].after.embeds[0]).not.toHaveProperty("fields");
  expect(result.targets[0].beforeFingerprint).toBe(before);
  const changed = structuredClone(input.messages[0]);
  changed.embeds[0].fields = [
    { ...field, value: buildSummaryUpgradeBody(7200) },
  ];
  expect(meetingUpdateMessageFingerprint(changed)).not.toBe(before);
  const shrink = fixture("x".repeat(4500), "Short");
  shrink.messages[0].embeds[1].fields = [field];
  expect(ready(shrink).targets[0].after.embeds).toEqual([
    expect.objectContaining({ description: "Short", fields: [field] }),
  ]);
});
test("reserves a page for a protected later post even when an earlier post has two slots", () => {
  const input = fixture("x".repeat(9000), "N".repeat(4500));
  input.messages[0].embeds.push(input.messages[1].embeds.shift()!);
  for (const post of input.messages.slice(0, 2))
    for (const embed of post.embeds) embed.description = "Old";
  input.messages[1].components = [{ type: 1 }];
  input.messages[1].embeds.at(-1)!.fields = [field];
  const result = ready(input);
  const survivors = result.targets.filter((target) =>
    input.history.notesMessageIds.includes(target.messageId),
  );
  expect(survivors).toHaveLength(2);
  expect(survivors.map((target) => target.after.embeds.length)).toEqual([1, 1]);
  expect(survivors[1].after.embeds[0]).toHaveProperty("fields", [field]);
});
test.each([
  { ...field, name: "Unknown" },
  { ...field, value: field.value + " changed" },
  { ...field, inline: true },
  { ...field, value: field.value.replace("1.5 hours", "1.50 hours") },
  { ...field, value: field.value.replace("1.5 hours", "1,5 hours") },
])("rejects a noncanonical field %j", (invalid) => {
  const input = fixture();
  input.messages[0].embeds[0].fields = [invalid];
  expect(planMeetingUpdate(input).kind).toBe("blocked");
});
test.each(["same", "separate", "unknown-key"])(
  "rejects duplicate or unsupported fields (%s)",
  (mode) => {
    const input = fixture("x".repeat(4500), "Short");
    input.messages[0].embeds[0].fields =
      mode === "same" ? [field, field] : [field];
    if (mode === "separate") input.messages[0].embeds[1].fields = [field];
    if (mode === "unknown-key")
      input.messages[0].embeds[0].fields = [{ ...field, extra: "unsafe" }];
    expect(planMeetingUpdate(input).kind).toBe("blocked");
  },
);
test.each([
  0, 59, 60, 120, 3600, 3601, 5400, 35999, 36000, 36001, 39600, 3600000,
])("recognizes only producer-canonical duration at %i seconds", (seconds) => {
  const input = fixture();
  input.messages[0].embeds[0].fields = [
    { ...field, value: buildSummaryUpgradeBody(seconds) },
  ];
  expect(ready(input).targets[0].after.embeds[0]).toHaveProperty(
    "fields",
    input.messages[0].embeds[0].fields,
  );
});
test("does not broaden recovery's strict notes recognizer", () => {
  expect(
    isNotesEmbed({
      title: "Meeting Notes",
      description: "notes",
      fields: [field],
    }),
  ).toBe(false);
});
test("keeps a protected message's unrelated payload and fails impossible aggregate limits", () => {
  const input = fixture("x".repeat(9000), "Short");
  const last = input.messages[1];
  for (const embed of last.embeds) embed.description = "Old";
  last.content = "Keep";
  last.attachments = [{ id: "123456" }];
  last.flags = 4;
  last.embeds.push({ description: "Z".repeat(4096) });
  const result = ready(input);
  expect(result.targets[0].after).toMatchObject({
    id: last.id,
    content: last.content,
    attachments: last.attachments,
    flags: 4,
  });
  expect(result.targets[0].after.embeds.at(-1)).toEqual(last.embeds.at(-1));
  input.history.notes = "N".repeat(2500);
  expect(planMeetingUpdate(input).kind).toBe("blocked");
});

test("a malformed field on a later versioned page cannot hide as an unrelated embed", () => {
  const input = fixture("x".repeat(4500), "Short");
  input.messages[0].embeds[1].fields = [{ name: "Unrelated", value: "Keep" }];
  expect(planMeetingUpdate(input).kind).toBe("blocked");
});
test.each(Array.from({ length: 90 }, (_, index) => (index + 11) * 360))(
  "accepts producer hour precision at %i seconds",
  (seconds) => {
    const input = fixture();
    input.messages[0].embeds[0].fields = [
      { ...field, value: buildSummaryUpgradeBody(seconds) },
    ];
    expect(planMeetingUpdate(input).kind).toBe("ready");
  },
);
