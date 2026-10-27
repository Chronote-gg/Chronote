/** @jest-environment node */
import { createHash } from "node:crypto";
import { sample } from "../fixtures/productionFixtureAcceptance";
import { inspectFixtureMetadata } from "../../src/services/productionFixtureAcceptance";
import { inspectFixtureCapture } from "../../src/services/productionFixtureCapture";
import type { RecordingManifest } from "../../src/types/recordingCheckpoint";

function capture(
  intervals = [
    [0, 100000],
    [100000, 100000],
  ],
) {
  const metadata = inspectFixtureMetadata(sample());
  const { history } = metadata;
  const prefix = `${history.checkpoint.artifactFolder}checkpoints/v1/1-${history.ownerInstanceId}/`;
  const audio = intervals.map(([startOffsetMs, durationMs], sequence) => {
    const bytes = Buffer.alloc(durationMs * 2, 1);
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      bytes,
      artifact: {
        kind: "audio" as const,
        sourceId: "user:actor",
        sequence,
        contentType: "application/octet-stream",
        format: {
          encoding: "pcm_s16le" as const,
          sampleRate: 1000,
          channels: 1,
        },
        timing: {
          basis: "sample_cursor_with_observed_gaps" as const,
          observedFirstOffsetMs: startOffsetMs,
          observedLastOffsetMs: startOffsetMs + durationMs,
          maxCursorAdjustmentMs: 0,
        },
        coverage: {
          kind: "known" as const,
          intervals: [{ sourceId: "user:actor", startOffsetMs, durationMs }],
        },
        object: {
          key: `${prefix}audio/user%3Aactor/${sequence}-${checksumSha256}`,
          byteLength: bytes.length,
          checksumSha256,
        },
      },
    };
  });
  const manifest: RecordingManifest = {
    schemaVersion: 1,
    revision: history.checkpoint.revision,
    artifactFolder: history.checkpoint.artifactFolder,
    capture: history.checkpoint.capture,
    fixtureInput: history.fixtureInput,
    captureState: history.capture,
    coverage: {
      kind: "verified",
      intervals: audio.flatMap((a) => a.artifact.coverage.intervals),
      savedDurationMs: 200000,
      lastConfirmedCaptureAt: history.fixtureInput.captureEndedAt!,
    },
    artifacts: audio.map((a) => a.artifact),
  };
  return {
    metadata,
    manifest,
    audio: new Map(audio.map((a) => [a.artifact.object.key, a.bytes])),
    handoffAt: "1970-01-01T00:03:22.000Z",
    acrossHandoff: true,
  };
}

test("recomputes verified actor PCM union and requires actual audio on both sides of handoff", () => {
  expect(inspectFixtureCapture(capture()).savedDurationMs).toBe(200000);
  expect(
    inspectFixtureCapture(
      capture([
        [0, 90000],
        [110000, 90000],
      ]),
    ).savedDurationMs,
  ).toBe(180000);
  for (const ranges of [
    [
      [0, 100000],
      [0, 100000],
    ],
    [
      [0, 80000],
      [120000, 80000],
    ],
  ]) {
    expect(() => inspectFixtureCapture(capture(ranges))).toThrow(
      "fixture_capture_refused",
    );
  }
  const after = capture();
  after.handoffAt = "1970-01-01T00:01:42.000Z";
  expect(() => inspectFixtureCapture(after)).toThrow();
});

test("forged span, wrong bytes, unverified or adjusted intervals never count as capture", () => {
  for (const change of [
    (f: ReturnType<typeof capture>) => {
      f.manifest.captureState = { kind: "unknown" };
    },
    (f: ReturnType<typeof capture>) => {
      f.audio.clear();
    },
    (f: ReturnType<typeof capture>) => {
      f.audio.values().next().value?.fill(9);
    },
    (f: ReturnType<typeof capture>) => {
      const a = f.manifest.artifacts[0];
      if (a.kind === "audio" && a.timing) a.timing.maxCursorAdjustmentMs = 1;
    },
    (f: ReturnType<typeof capture>) => {
      f.manifest.artifacts[0].sourceId = "user:other";
    },
  ]) {
    const value = capture();
    change(value);
    expect(() => inspectFixtureCapture(value)).toThrow();
  }
});
