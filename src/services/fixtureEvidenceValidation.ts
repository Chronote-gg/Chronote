import { isDeepStrictEqual } from "node:util";
import {
  fixtureInputEvidenceSchema,
  type FixtureInputEvidence,
} from "../types/fixtureEvidence";
import type { RecordingCaptureProvenance } from "../types/recordingCheckpoint";
const counters = [
  "acceptedPcmChunks",
  "acceptedPcmBytes",
  "unexpectedMembers",
  "unexpectedSourceAttempts",
  "rejectedMessages",
  "rejectedAttachments",
  "ttsAttempts",
  "continuityFailures",
] as const;
export function validateFixtureCapture(
  capture: RecordingCaptureProvenance,
  value: FixtureInputEvidence | undefined,
  previous?: FixtureInputEvidence,
) {
  if (!value) {
    if (previous) throw new Error("Fixture evidence cannot disappear");
    return;
  }
  const input = fixtureInputEvidenceSchema.parse(value);
  validateLineage(capture, input);
  validateClosure(input);
  validateTimes(input);
  validateMonotonic(input, previous);
}
function validateLineage(
  capture: RecordingCaptureProvenance,
  input: FixtureInputEvidence,
) {
  if (
    input.historyKey.guildId !== capture.guildId ||
    input.historyKey.channelId_timestamp !== capture.channelId_timestamp ||
    input.ownership.guildId !== capture.guildId ||
    input.ownership.meetingId !== capture.meetingId ||
    input.ownership.ownerInstanceId !== capture.ownerInstanceId ||
    input.ownership.executionVersion !== capture.executionVersion ||
    input.captureStartedAt !== capture.captureStartedAt ||
    input.acceptedSourceId !== `user:${input.actorUserId}`
  )
    throw new Error("Fixture capture lineage mismatch");
}
function validateClosure(input: FixtureInputEvidence) {
  if (
    input.state === "closed" &&
    (!input.observationStartedAt ||
      !input.captureStartedAt ||
      !input.captureEndedAt ||
      !input.observationEndedAt ||
      input.failureReasons.length ||
      input.overflow ||
      input.continuityFailures ||
      input.unexpectedMembers ||
      input.unexpectedSourceAttempts ||
      input.rejectedMessages ||
      input.rejectedAttachments ||
      input.ttsAttempts)
  )
    throw new Error("Closed fixture requires uninterrupted observation");
}
function validateTimes(input: FixtureInputEvidence) {
  const times = [
    input.observationStartedAt,
    input.captureStartedAt,
    input.captureEndedAt,
    input.observationEndedAt,
  ]
    .filter((value) => value !== null)
    .map(Date.parse);
  if (times.some((value, index) => index > 0 && value < times[index - 1]))
    throw new Error("Fixture lifecycle timestamps must be monotonic");
}
function validateMonotonic(
  input: FixtureInputEvidence,
  previous?: FixtureInputEvidence,
) {
  if (!previous) return;
  for (const key of [
    "reference",
    "commandId",
    "actorUserId",
    "scriptSha256",
    "checklistSha256",
    "ownership",
    "historyKey",
    "observationStartedAt",
    "captureStartedAt",
    "acceptedSourceId",
  ] as const)
    if (
      !isDeepStrictEqual(
        structuredClone(input[key]),
        structuredClone(previous[key]),
      )
    )
      throw new Error("Fixture identity cannot change");
  if (
    counters.some((key) => input[key] < previous[key]) ||
    previous.failureReasons.some(
      (reason) => !input.failureReasons.includes(reason),
    ) ||
    (previous.overflow && !input.overflow) ||
    (["incomplete", "contaminated"].includes(previous.state) &&
      ["observing", "closed"].includes(input.state)) ||
    (previous.state === "contaminated" && input.state !== "contaminated") ||
    closureChanged(input, previous)
  )
    throw new Error("Fixture evidence cannot erase observed failures");
}

function closureChanged(
  input: FixtureInputEvidence,
  previous: FixtureInputEvidence,
) {
  return ["captureEndedAt", "observationEndedAt"].some((key) => {
    const field = key as "captureEndedAt" | "observationEndedAt";
    return previous[field] !== null && previous[field] !== input[field];
  });
}
