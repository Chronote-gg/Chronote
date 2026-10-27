/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import {
  inspectFixtureMetadata,
  inspectFixtureGeneration,
  inspectFixtureFallbacks,
} from "../../src/services/productionFixtureAcceptance";
import { sample } from "../fixtures/productionFixtureAcceptance";

describe("generated fixture metadata before content", () => {
  test("local fallback zero maps only to the reviewed transcription template and actual configured name", () => {
    const value = sample().history.fixtureGeneration;
    value.tuples[0].prompt = {
      kind: "resolved",
      name: "configured-transcription",
      version: 0,
      fallback: true,
    };
    expect(inspectFixtureFallbacks(value, "configured-transcription")).toEqual([
      "src/services/transcriptionPromptService.ts",
    ]);
    expect(() =>
      inspectFixtureFallbacks(value, "different-template"),
    ).toThrow();
    value.tuples[0].prompt.fallback = false;
    expect(() =>
      inspectFixtureFallbacks(value, "configured-transcription"),
    ).toThrow();
    value.tuples[0].prompt.fallback = true;
    value.tuples[0].stage = "notes";
    expect(() =>
      inspectFixtureFallbacks(value, "configured-transcription"),
    ).toThrow();
  });
  test("uses original consumed ownership, closed clean capture and direct delivery to compute waits", () => {
    const result = inspectFixtureMetadata(sample());
    expect(result.firstNotesWaitMs).toBe(8000);
    expect(result.completeNotesWaitMs).toBe(10000);
  });
  test("rejects copied lineage, unbound input, partial capture, changed output and unknown ACKs", () => {
    const mutations: Array<(v: ReturnType<typeof sample>) => void> = [
      (v) => {
        v.history.ownerInstanceId = "other";
      },
      (v) => {
        v.history.fixtureInput.ownership.voiceOperationAttemptId = "other";
      },
      (v) => {
        v.history.fixtureInput.reference.holdId = "other";
      },
      (v) => {
        v.history.fixtureInput.unexpectedMembers = 1;
      },
      (v) => {
        v.history.fixtureInput.continuityFailures = 1;
      },
      (v) => {
        v.history.fixtureInput.state = "observing";
      },
      (v) => {
        v.history.fixtureInput.acceptedPcmChunks = 0;
      },
      (v) => {
        v.history.fixtureGeneration.acknowledged--;
      },
      (v) => {
        v.history.capture.kind = "interrupted";
      },
      (v) => {
        v.history.capture.endedAt = "bad clock";
      },
      (v) => {
        v.history.notesVersion = 2;
      },
      (v) => {
        v.history.notesChannelId = "other";
      },
      (v) => {
        v.history.delivery.notes.sent = 0;
      },
      (v) => {
        v.history.notesDeliveryTiming.path = "recovery";
      },
      (v) => {
        v.history.recovery.attempt = 1;
      },
      (v) => {
        v.history.fixtureTranscript.acknowledgment.state = "unknown";
      },
      (v) => {
        v.history.fixtureTranscript.acknowledgment.versionId = "null";
      },
      (v) => {
        v.now = 311;
      },
    ];
    for (const change of mutations) {
      const value = sample();
      change(value);
      expect(() => inspectFixtureMetadata(value)).toThrow();
    }
  });
  test("requires bounded complete request accounting and every always-used output stage", () => {
    expect(
      inspectFixtureGeneration(sample().history.fixtureGeneration).acknowledged,
    ).toBe(3);
    for (const change of [
      (v: ReturnType<typeof sample>["history"]["fixtureGeneration"]) => {
        v.acknowledged--;
      },
      (v: ReturnType<typeof sample>["history"]["fixtureGeneration"]) => {
        v.missing++;
      },
      (v: ReturnType<typeof sample>["history"]["fixtureGeneration"]) => {
        v.overflow = true;
      },
      (v: ReturnType<typeof sample>["history"]["fixtureGeneration"]) => {
        v.tuples[1].stage = "other";
      },
      (v: ReturnType<typeof sample>["history"]["fixtureGeneration"]) => {
        v.tuples[0].count++;
      },
    ]) {
      const generation = sample().history.fixtureGeneration;
      change(generation);
      expect(() => inspectFixtureGeneration(generation)).toThrow();
    }
  });
});
