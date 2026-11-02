/** @jest-environment node */
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import {
  meetingUpdateMessageFingerprint,
  observedMeetingUpdateCreationFingerprint,
} from "../../src/services/meetingUpdateFingerprint";
import { recoveredFixture } from "./recoveredMeetingLayout.fixture";
import { fixture } from "./meetingUpdatePlan.fixture";

describe("Discord embed scan metadata", () => {
  it.each([0, 1, Number.MAX_SAFE_INTEGER])(
    "ignores received scan version %s for plans, payloads and fingerprints",
    (version) => {
      for (const input of [fixture(), recoveredFixture()]) {
        input.history.summarySentence = "Edited summary";
        input.history.updateDelivery.parts.summaryBody = {
          desired: 1,
          acknowledged: 0,
        };
        const baseline = planMeetingUpdate(input);
        expect(baseline.kind).toBe("ready");
        const fingerprints = input.messages.map((message) => [
          meetingUpdateMessageFingerprint(message),
          observedMeetingUpdateCreationFingerprint(message),
        ]);
        for (const message of input.messages)
          for (const embed of message.embeds)
            embed.content_scan_version = version;
        expect(planMeetingUpdate(input)).toEqual(baseline);
        expect(
          input.messages.map((message) => [
            meetingUpdateMessageFingerprint(message),
            observedMeetingUpdateCreationFingerprint(message),
          ]),
        ).toEqual(fingerprints);
        const result = planMeetingUpdate(input);
        if (result.kind !== "ready") throw new Error("Expected editable plan");
        expect(result.payloads).toHaveLength(2);
        for (const payload of result.payloads)
          for (const embed of payload.payload.embeds)
            expect(embed).not.toHaveProperty("content_scan_version");
      }
    },
  );

  it.each([
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "0",
    false,
    null,
    {},
  ])("blocks an invalid received scan version %p", (version) => {
    const input = recoveredFixture();
    input.messages[0].embeds[0].content_scan_version = version;
    expect(planMeetingUpdate(input)).toEqual({
      kind: "blocked",
      reason: "unsupported_embed",
    });
  });

  it.each(["unknown_top_level", "unknown_nested"])(
    "retains strict rejection for %s alongside valid scan metadata",
    (kind) => {
      const input = recoveredFixture();
      const embed = input.messages[0].embeds[0];
      embed.content_scan_version = 0;
      if (kind === "unknown_top_level") embed.unrecognized = 1;
      else embed.footer = { text: "Saved footer", content_scan_version: 0 };
      expect(planMeetingUpdate(input)).toEqual({
        kind: "blocked",
        reason: "unsupported_embed",
      });
    },
  );
});
