/** @jest-environment node */
import {
  fixture,
  notesWarningFixture,
  message,
  botId,
} from "./meetingUpdatePlan.fixture";
import {
  planMeetingUpdate,
  meetingUpdateMessageFingerprint,
  meetingUpdateCreationFingerprint,
  observedMeetingUpdateCreationFingerprint,
} from "../../src/services/meetingUpdatePlan";
import { now } from "../types/meetingUpdateDelivery.fixture";
import { PARTIAL_TRANSCRIPT_NOTICE } from "../../src/utils/meetingProcessing";

function retainedInput() {
  const input = fixture();
  const retained = message("999996", [
    { title: "Meeting Notes", description: "Obsolete", footer: { text: "v1" } },
  ]);
  input.messages.push(retained);
  input.history.updateDelivery.cleanupCandidates = [
    {
      sourceAttemptId: "retired-attempt",
      operationId: "retired-delete",
      registrationOperationId: "retired-register",
      channelId: retained.channel_id,
      messageId: retained.id,
      beforeFingerprint: meetingUpdateMessageFingerprint(retained),
    },
  ];
  return input;
}
it.each(["shrink", "growth"])(
  "carries exact retained targets into latest %s cleanup after registration",
  (mode) => {
    const input = retainedInput();
    if (mode === "growth") input.history.notes = "n".repeat(9000);
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    const cleanup = result.attempt.operations.at(-1);
    expect(cleanup).toMatchObject({
      kind: "delete",
      messageId: "999996",
      beforeFingerprint:
        input.history.updateDelivery.cleanupCandidates[0].beforeFingerprint,
    });
    const registrationIndex = result.attempt.operations.findIndex(
      (op) => op.kind === "register",
    );
    expect(registrationIndex).toBeGreaterThanOrEqual(0);
    expect(registrationIndex).toBeLessThan(
      result.attempt.operations.length - 1,
    );
    expect(
      result.attempt.operations.filter((op) => op.kind === "post"),
    ).toHaveLength(mode === "growth" ? 1 : 0);
    expect(result.attempt.capturedParts).toEqual({ notesBody: 1 });
  },
);
it.each(["changed", "protected", "currently-registered", "missing"])(
  "retains a blocker for a %s obsolete target",
  (mode) => {
    const input = retainedInput();
    const retained = input.messages.at(-1)!;
    if (mode === "changed") retained.embeds[0].description = "Changed remotely";
    if (mode === "protected") {
      retained.content = "Keep this";
      input.history.updateDelivery.cleanupCandidates[0].beforeFingerprint =
        meetingUpdateMessageFingerprint(retained);
    }
    if (mode === "currently-registered")
      input.history.notesMessageIds.push(retained.id);
    if (mode === "missing") input.messages.pop();
    const before = structuredClone(input);
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("blocked");
    expect(result).not.toHaveProperty("attempt");
    expect(input).toEqual(before);
  },
);
it("preserves a known created ID and plans exact cleanup instead of recreating it", () => {
  const input = fixture();
  const created = message("999996", [
    {
      title: "Meeting Notes",
      description: "Prior created page",
      footer: { text: "v1" },
    },
  ]);
  input.messages.push(created);
  input.history.updateDelivery.createdCandidates = [
    {
      operationId: "old-post",
      channelId: created.channel_id,
      messageId: created.id,
      fingerprint: observedMeetingUpdateCreationFingerprint(created),
    },
  ];
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.attempt.operations.map((op) => op.kind)).toEqual([
    "patch",
    "register",
    "delete",
  ]);
  expect(result.attempt.operations.at(-1)).toMatchObject({
    messageId: created.id,
  });
  expect(input.history.updateDelivery.createdCandidates[0].messageId).toBe(
    created.id,
  );
});
it("defines creation hashes independently of returned IDs and full existing-target hashes", () => {
  const input = fixture("Old", "n".repeat(9000));
  const plan = planMeetingUpdate(input);
  expect(plan.kind).toBe("ready");
  if (plan.kind !== "ready") return;
  const payload = plan.payloads.find((item) => item.kind === "post")!;
  const operation = plan.attempt.operations.find(
    (item) => item.kind === "post",
  )!;
  if (operation.kind !== "post") throw new Error("Expected POST");
  const first = message("999995", payload.payload.embeds);
  const second = { ...first, id: "999996" };
  expect(observedMeetingUpdateCreationFingerprint(first)).toBe(
    operation.desiredFingerprint,
  );
  expect(observedMeetingUpdateCreationFingerprint(second)).toBe(
    operation.desiredFingerprint,
  );
  expect(
    meetingUpdateCreationFingerprint({
      channelId: first.channel_id,
      botId,
      embeds: payload.payload.embeds,
    }),
  ).toBe(operation.desiredFingerprint);
  expect(meetingUpdateMessageFingerprint(first)).not.toBe(
    meetingUpdateMessageFingerprint(second),
  );
  expect(meetingUpdateMessageFingerprint(first)).not.toBe(
    operation.desiredFingerprint,
  );
  expect(() =>
    observedMeetingUpdateCreationFingerprint({
      ...first,
      content: "Protected",
    }),
  ).toThrow(/protected_creation/);
});
it("does not turn missing saved targets, unsettled attempts or holds into creation permission", () => {
  for (const variant of ["missing", "held", "unknown"]) {
    const input = fixture("Old", "n".repeat(9000));
    if (variant === "missing") input.messages.shift();
    if (variant === "held")
      input.history.updateDelivery.policy = {
        kind: "held",
        reason: "explicit_hold",
      };
    if (variant === "unknown") {
      const result = planMeetingUpdate(input);
      if (result.kind !== "ready") throw new Error("Expected ready");
      input.history.updateDelivery.progress = {
        kind: "running",
        attempt: result.attempt,
        claim: { ownerInstanceId: "old", leaseExpiresAt: now - 1 },
        nextCheckAt: now,
        operations: result.attempt.operations.map((operation, index) => ({
          operationId: operation.operationId,
          submission:
            index === 0
              ? {
                  kind: "submitted",
                  submissionId: "unknown",
                  submittedAt: now - 10,
                }
              : { kind: "prepared" },
        })),
      };
    }
    expect(planMeetingUpdate(input).kind).toBe("blocked");
  }
});
it("preserves body/version/title in a warning-only notes refresh", () => {
  const input = notesWarningFixture();
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[0].after.embeds[0]).toMatchObject({
    description: "Old notes",
    title: "Meeting Notes",
    footer: { text: "v1 • " + PARTIAL_TRANSCRIPT_NOTICE },
  });
  expect(result.targets[1].after).toEqual(input.messages[1]);
  expect(result.attempt.capturedParts).toEqual({ notesWarning: 1 });
});
it("preserves render-significant whitespace and supported proxy metadata", () => {
  const input = fixture();
  const extra = {
    title: "Keep  ",
    description: "\nKeep\n ",
    image: {
      url: "https://example.test/image.png",
      proxy_url: "https://example.test/proxy.png",
      width: 10,
      height: 20,
    },
    footer: {
      text: "Keep",
      icon_url: "https://example.test/icon.png",
      proxy_icon_url: "https://example.test/proxy-icon.png",
    },
  };
  input.messages[0].embeds.push(extra);
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[0].after.embeds[1]).toEqual(extra);
  expect(result.payloads[0].payload.embeds[1]).toEqual(extra);
});
it.each(["embed-count", "description", "fields", "title", "target-bound"])(
  "blocks complete %s limit violations",
  (mode) => {
    const input = fixture();
    if (mode === "embed-count")
      input.messages[0].embeds.push(
        ...Array.from({ length: 10 }, () => ({ description: "Other" })),
      );
    if (mode === "description") input.history.notes = "x".repeat(4096); // renderer paginates, an existing unrelated embed must still be checked
    if (mode === "description")
      input.messages[0].embeds.push({ description: "x".repeat(4097) });
    if (mode === "fields")
      input.messages[0].embeds.push({
        fields: [{ name: "Keep", value: "x".repeat(1025) }],
      });
    if (mode === "title") input.history.meetingName = "x".repeat(257);
    if (mode === "title")
      input.history.updateDelivery.parts.notesTitle = {
        desired: 1,
        acknowledged: 0,
      };
    if (mode === "target-bound") input.history.notes = "x".repeat(4096 * 101);
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("blocked");
    expect(result).not.toHaveProperty("attempt");
  },
);

it.each([
  ["partial-transcript", PARTIAL_TRANSCRIPT_NOTICE],
  [
    "interruption",
    "Partial notes: recording was interrupted. These notes cover only the saved recording. Saved recording coverage is unknown. The exact recording end time is unknown.",
  ],
])(
  "keeps a literal %s paragraph without matching footer evidence",
  (_kind, notice) => {
    const input = notesWarningFixture(notice + "\n\nUser notes");
    const result = planMeetingUpdate(input);
    expect(result.kind).toBe("ready");
    if (result.kind !== "ready") return;
    expect(result.targets[0].after.embeds[0].description).toBe(
      input.messages[0].embeds[0].description,
    );
  },
);

it.each(["created", "cleanup"])(
  "blocks retained %s work instead of returning idle with no requested parts",
  (kind) => {
    const input = retainedInput();
    for (const watermark of Object.values(input.history.updateDelivery.parts))
      watermark.acknowledged = watermark.desired;
    if (kind === "created") {
      const retained = input.messages.at(-1)!;
      input.history.updateDelivery.cleanupCandidates = [];
      input.history.updateDelivery.createdCandidates = [
        {
          operationId: "prior",
          channelId: retained.channel_id,
          messageId: retained.id,
          fingerprint: observedMeetingUpdateCreationFingerprint(retained),
        },
      ];
    }
    expect(planMeetingUpdate(input)).toEqual({
      kind: "blocked",
      reason: "retained_work_without_requested_parts",
    });
  },
);
it("blocks a retained creation identity aliased across channels", () => {
  const input = fixture();
  const target = input.messages[0];
  input.history.updateDelivery.createdCandidates = [
    {
      operationId: "prior",
      channelId: "999997",
      messageId: target.id,
      fingerprint: observedMeetingUpdateCreationFingerprint(target),
    },
  ];
  expect(planMeetingUpdate(input)).toEqual({
    kind: "blocked",
    reason: "aliased_target",
  });
});
it("uses initial summary selection semantics for an explicitly empty sentence", () => {
  const input = fixture();
  input.history.summarySentence = "";
  input.history.summaryLabel = "Label";
  input.history.updateDelivery.parts.notesBody = {
    desired: 0,
    acknowledged: 0,
  };
  input.history.updateDelivery.parts.summaryBody = {
    desired: 1,
    acknowledged: 0,
  };
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[1].after.embeds[0].description).toBe(
    "Summary unavailable.",
  );
});

it("refreshes an interruption prefix proven by its existing footer and keeps the body", () => {
  const notice =
    "Partial notes: recording was interrupted. These notes cover only the saved recording. Saved recording coverage is unknown. The exact recording end time is unknown.";
  const input = notesWarningFixture(notice + "\n\nUser notes");
  input.messages[0].embeds[0].footer = { text: "v1 • " + notice };
  const result = planMeetingUpdate(input);
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(result.targets[0].after.embeds[0]).toMatchObject({
    description: "User notes",
    footer: { text: "v1 • " + PARTIAL_TRANSCRIPT_NOTICE },
  });
});
