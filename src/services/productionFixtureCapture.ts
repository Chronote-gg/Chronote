import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  recordingManifestSchema,
  type CheckpointSegment,
} from "../types/recordingCheckpoint";
import type { inspectFixtureMetadata } from "./productionFixtureAcceptance";

const MINIMUM_CAPTURE_MS = 180000;
function refuse(): never {
  throw new Error("fixture_capture_refused");
}

function verifiedIntervals(
  artifact: CheckpointSegment,
  bytes: Uint8Array | undefined,
) {
  const { object, format, coverage, timing } = artifact;
  if (
    !bytes ||
    bytes.byteLength !== object.byteLength ||
    createHash("sha256").update(bytes).digest("hex") !==
      object.checksumSha256 ||
    coverage.kind !== "known" ||
    !coverage.intervals.length ||
    !timing ||
    timing.maxCursorAdjustmentMs !== 0 ||
    bytes.byteLength === 0 ||
    bytes.byteLength % (format.channels * 2) !== 0
  )
    refuse();
  const duration =
    (bytes.byteLength / (format.channels * 2 * format.sampleRate)) * 1000;
  if (
    Math.abs(
      coverage.intervals.reduce(
        (sum, interval) => sum + interval.durationMs,
        0,
      ) - duration,
    ) > 0.000001
  )
    refuse();
  return coverage.intervals;
}

/** Pure check over independently fetched bytes. It grants no read or mutation authority. */
export function inspectFixtureManifest(input: {
  metadata: ReturnType<typeof inspectFixtureMetadata>;
  manifest: unknown;
}) {
  const manifest = recordingManifestSchema.parse(input.manifest);
  const { history } = input.metadata;
  const pointer = history.checkpoint;
  if (
    !isDeepStrictEqual(manifest.capture, pointer.capture) ||
    manifest.revision !== pointer.revision ||
    manifest.artifactFolder !== pointer.artifactFolder ||
    !isDeepStrictEqual(manifest.fixtureInput, history.fixtureInput) ||
    !isDeepStrictEqual(manifest.captureState, history.capture) ||
    manifest.captureState.kind !== "complete"
  )
    refuse();
  const prefix = `${pointer.artifactFolder}checkpoints/v1/1-${encodeURIComponent(history.ownerInstanceId)}/`;
  const identities = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const identity = `${artifact.kind}/${encodeURIComponent(artifact.sourceId)}/${artifact.sequence}`;
    if (
      identities.has(identity) ||
      artifact.object.key !==
        `${prefix}${identity}-${artifact.object.checksumSha256}`
    )
      refuse();
    identities.add(identity);
    if (
      artifact.kind === "audio" &&
      artifact.sourceId !== history.fixtureInput.acceptedSourceId
    )
      refuse();
  }
  return manifest;
}

export function inspectFixtureSavedAudio(input: {
  metadata: ReturnType<typeof inspectFixtureMetadata>;
  manifest: unknown;
  audio: ReadonlyMap<string, Uint8Array>;
  acrossHandoff: boolean;
}) {
  const manifest = inspectFixtureManifest(input);
  if (manifest.captureState.kind !== "complete") refuse();
  const start = Date.parse(manifest.captureState.startedAt),
    end = Date.parse(manifest.captureState.endedAt);
  if (end <= start || (input.acrossHandoff && end - start < MINIMUM_CAPTURE_MS))
    refuse();
  const intervals = manifest.artifacts.flatMap((artifact) =>
    artifact.kind === "audio"
      ? verifiedIntervals(artifact, input.audio.get(artifact.object.key))
      : [],
  );
  if (
    !intervals.length ||
    intervals.some(
      (interval) => interval.startOffsetMs + interval.durationMs > end - start,
    )
  )
    refuse();
  let savedDurationMs = 0,
    previousEnd = 0;
  for (const interval of intervals.sort(
    (a, b) => a.startOffsetMs - b.startOffsetMs,
  )) {
    const nextEnd = interval.startOffsetMs + interval.durationMs;
    savedDurationMs += Math.max(
      0,
      nextEnd - Math.max(previousEnd, interval.startOffsetMs),
    );
    previousEnd = Math.max(previousEnd, nextEnd);
  }
  if (input.acrossHandoff && savedDurationMs < MINIMUM_CAPTURE_MS) refuse();
  return { savedDurationMs, captureSpanMs: end - start, intervals };
}

export function inspectFixtureCapture(
  input: Parameters<typeof inspectFixtureSavedAudio>[0] & { handoffAt: string },
) {
  const result = inspectFixtureSavedAudio(input);
  const state = input.metadata.history.capture;
  if (state.kind !== "complete") refuse();
  const handoff = Date.parse(input.handoffAt) - Date.parse(state.startedAt);
  if (
    !Number.isFinite(handoff) ||
    (input.acrossHandoff &&
      (!result.intervals.some((interval) => interval.startOffsetMs < handoff) ||
        !result.intervals.some(
          (interval) => interval.startOffsetMs + interval.durationMs > handoff,
        ))) ||
    (!input.acrossHandoff && handoff >= 0)
  )
    refuse();
  return {
    savedDurationMs: result.savedDurationMs,
    captureSpanMs: result.captureSpanMs,
  };
}
