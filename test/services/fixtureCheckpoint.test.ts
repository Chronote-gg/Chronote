/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { validateFixtureCapture } from "../../src/services/fixtureEvidenceValidation";
import {
  capture,
  digest,
  ownership,
  fixture,
  input,
} from "../fixtures/recordingCheckpoint";
test("metadata-only manifest loading never follows context or audio references", async () => {
  const f = fixture();
  const context = Buffer.from("private context must not be read");
  const first = await f.service.flush({
    ...input,
    artifacts: [
      ...input.artifacts,
      {
        kind: "context",
        sourceId: "context",
        sequence: 1,
        coverage: { kind: "unknown" },
        contentType: "application/json",
        bytes: context,
        checksumSha256: digest(context),
      },
    ],
  });
  if (first.kind !== "committed") throw new Error("Fixture checkpoint failed");
  f.read.mockClear();
  const manifest = await f.service.readMetadata(first.checkpoint);
  expect(manifest.artifacts).toHaveLength(2);
  expect(f.read.mock.calls).toEqual([
    [first.checkpoint.manifest.key, undefined],
  ]);
});

test("fixture producer retains monotonic evidence through acknowledged manifest revisions", async () => {
  const f = fixture();
  const service = f.service.createProducerSession();
  const fixtureInput = {
    schemaVersion: 1,
    profile: "manual_script_v1",
    reference: {
      introductionId: "intro",
      holdId: "hold",
      grantId: "grant",
      revision: 1,
    },
    commandId: "command",
    actorUserId: "actor",
    scriptSha256: "a".repeat(64),
    checklistSha256: "b".repeat(64),
    ownership,
    historyKey: {
      guildId: capture.guildId,
      channelId_timestamp: capture.channelId_timestamp,
    },
    observationStartedAt: capture.reservedAt,
    captureStartedAt: capture.captureStartedAt,
    captureEndedAt: null,
    observationEndedAt: null,
    acceptedSourceId: "user:actor",
    acceptedPcmChunks: 1,
    acceptedPcmBytes: 96000,
    unexpectedMembers: 0,
    unexpectedSourceAttempts: 0,
    rejectedMessages: 0,
    rejectedAttachments: 0,
    ttsAttempts: 0,
    continuityFailures: 0,
    overflow: false,
    state: "observing",
    failureReasons: [],
  } as const;
  validateFixtureCapture(capture, { ...fixtureInput, failureReasons: [] });
  const first = await service.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
    fixtureInput: { ...fixtureInput, failureReasons: [] },
  });
  expect(first).toMatchObject({ kind: "committed" });
  if (first.kind !== "committed") throw new Error("First checkpoint failed");
  const second = await service.flush({
    ...input,
    ownership,
    signal: new AbortController().signal,
    previous: first.checkpoint,
    fixtureInput: { ...fixtureInput, acceptedPcmChunks: 2, failureReasons: [] },
  });
  expect(second.kind).toBe("committed");
  if (second.kind !== "committed") throw new Error("Second checkpoint failed");
  const metadata = await service.readMetadata(second.checkpoint);
  expect(metadata.fixtureInput?.acceptedPcmChunks).toBe(2);
  expect(second.checkpoint.revision).toBe(first.checkpoint.revision + 1);
});
