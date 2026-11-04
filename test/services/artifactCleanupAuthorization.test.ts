/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { createCleanupAuthorization } from "../../src/services/artifactCleanupAuthorization";
import { fixture, input, capture } from "../fixtures/recordingCheckpoint";
import { history } from "../deployment/controlFixtures";
import type { ArtifactCleanupReceipt } from "../../src/types/artifactCleanup";

async function setup() {
  const f = fixture();
  const result = await f.service.flush({
    ...input,
    captureState: {
      kind: "complete",
      startedAt: capture.captureStartedAt!,
      endedAt: "2026-01-01T00:00:04Z",
    },
  });
  if (result.kind !== "committed") throw new Error("Checkpoint fixture failed");
  const row = f.histories.get(history.guildId)![0];
  row.status = "complete";
  row.audioS3Key = `${result.checkpoint.artifactFolder}audio_combined.mp3`;
  const object = {
    key: row.audioS3Key,
    checksumSha256: "a".repeat(64),
    byteLength: 8,
    versionId: "version",
  };
  const receipt: ArtifactCleanupReceipt = {
    version: 1,
    owner: {
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
    },
    historyKey: history.channelId_timestamp,
    createdAt: "2026-11-03T12:00:00Z",
    files: [
      { path: "track.pcm", checksumSha256: "b".repeat(64), byteLength: 96_000 },
    ],
    producers: [
      {
        path: "track.pcm",
        state: "known",
        provenance: { kind: "captured_audio", producer: "speaker_track" },
      },
    ],
    storedArtifacts: [object],
    checkpoint: result.checkpoint,
    decision: "complete",
  };
  const verifyStoredArtifact = jest.fn(async () => undefined);
  const authorize = createCleanupAuthorization({
    repository: f.repository,
    checkpoints: f.service,
    verifyStoredArtifact,
  });
  return { ...f, row, receipt, authorize, verifyStoredArtifact };
}

test("complete registered capture requires the current verified checkpoint and final object", async () => {
  const f = await setup();
  await expect(f.authorize(f.receipt)).resolves.toMatchObject({
    owner: f.receipt.owner,
    historyKey: f.receipt.historyKey,
    checkpoint: f.receipt.checkpoint,
    status: "complete",
    audioS3Key: f.row.audioS3Key,
  });
  expect(f.verifyStoredArtifact).toHaveBeenCalledWith(
    f.receipt.storedArtifacts[0],
    undefined,
  );
});

test.each([
  "owner",
  "execution",
  "missing_checkpoint",
  "corrupt_object",
  "unknown_file",
  "uncertain_writer",
  "partial_capture",
])("%s refuses cleanup authority", async (reason) => {
  const f = await setup();
  if (reason === "owner") f.row.ownerInstanceId = "different";
  if (reason === "execution") f.row.executionVersion = 2;
  if (reason === "missing_checkpoint")
    f.objects.delete(f.receipt.checkpoint!.manifest.key);
  if (reason === "corrupt_object")
    f.verifyStoredArtifact.mockImplementation(async () => {
      throw new Error("Corrupt stored object");
    });
  if (reason === "unknown_file") f.receipt.producers = [];
  if (reason === "uncertain_writer") f.receipt.producers[0].state = "uncertain";
  if (reason === "partial_capture") f.row.status = "interrupted";
  await expect(f.authorize(f.receipt)).rejects.toThrow();
});

test("authority is checked again after remote verification settles", async () => {
  const f = await setup();
  f.verifyStoredArtifact.mockImplementation(async () => {
    f.row.executionVersion = 2;
    return undefined;
  });
  await expect(f.authorize(f.receipt)).rejects.toThrow();
});

test("pure recovery scratch binds verified original inputs without claiming complete capture or old ownership", async () => {
  const f = await setup();
  const checkpoint = await f.service.read(f.receipt.checkpoint!);
  const object = checkpoint.verified[0].object;
  f.row.status = "interrupted";
  f.row.executionVersion = 2;
  f.receipt.owner.executionVersion = 2;
  f.receipt.decision = "scratch";
  f.receipt.storedArtifacts = [{ ...object, versionId: null }];
  f.receipt.producers = [
    {
      path: "track.pcm",
      state: "uncertain",
      provenance: { kind: "stored_derivative", inputs: [object] },
    },
  ];
  await expect(f.authorize(f.receipt)).resolves.toMatchObject({
    owner: f.receipt.owner,
    status: "interrupted",
  });
  f.receipt.producers[0].provenance = {
    kind: "stored_derivative",
    inputs: [{ ...object, key: "unrelated" }],
  };
  await expect(f.authorize(f.receipt)).rejects.toThrow();
});
