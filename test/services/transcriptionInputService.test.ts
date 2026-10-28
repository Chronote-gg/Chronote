/** @jest-environment node */
import { mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  withPreparedTranscriptionInput,
  TranscriptionInputRequest,
} from "../../src/services/transcriptionInputService";

let directory: string;
let request: TranscriptionInputRequest;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "chronote-prepared-"));
  request = {
    pcm: Buffer.alloc(192000),
    pcmFile: path.join(directory, "input.pcm"),
    wavFile: path.join(directory, "input.wav"),
    mode: "enforce",
    phase: "slow",
    force: false,
    policyFingerprint: "test-policy",
    detector: {
      warm: async () => true,
      shutdown: async () => {},
      assess: async () => ({
        kind: "unavailable",
        policyFingerprint: "test-policy",
        reason: "not_ready",
      }),
    },
    observe: () => {},
  };
});
afterEach(() => {
  expect(readdirSync(directory)).toEqual([]);
  rmdirSync(directory);
});
test("consumer errors retain their identity and clean both temporary inputs", async () => {
  const error = new Error("consumer failed");
  await expect(
    withPreparedTranscriptionInput(request, async (prepared) => {
      expect(readdirSync(directory).sort()).toEqual(["input.pcm", "input.wav"]);
      expect(prepared.coverage.audioBytes).toBe(192000);
      expect(prepared.coverage.policyFingerprint).toBe("test-policy");
      throw error;
    }),
  ).rejects.toBe(error);
});
test("observer failure cannot replace an assessed admission or consumer result", async () => {
  request.observe = () => {
    throw new Error("metric failed");
  };
  expect(
    await withPreparedTranscriptionInput(request, async ({ admission }) => {
      expect(admission).toMatchObject({
        kind: "assessed",
        assessment: { kind: "unavailable", reason: "not_ready" },
      });
      return "consumer result";
    }),
  ).toBe("consumer result");
});
test.each(["shadow", "enforce"] as const)(
  "synchronous detector errors fail open in %s",
  async (mode) => {
    request.mode = mode;
    request.detector!.assess = () => {
      throw new Error("synchronous failure");
    };
    const observations: string[] = [];
    request.observe = (assessment) => {
      observations.push(assessment.kind);
    };
    expect(
      await withPreparedTranscriptionInput(request, async () => "retained"),
    ).toBe("retained");
    expect(observations).toEqual(["unavailable"]);
  },
);
