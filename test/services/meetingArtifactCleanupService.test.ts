/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/db", () => ({
  ...jest.requireActual("../../src/db"),
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/services/uploadService", () => ({
  ...jest.requireActual("../../src/services/uploadService"),
  getVerifiedMeetingArtifacts: jest.fn(),
}));
jest.mock("../../src/services/storageService", () => ({
  ...jest.requireActual("../../src/services/storageService"),
  verifyStoredArtifact: jest.fn(),
}));
import { promises as fs } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  fixture,
  input,
  capture,
  bytes,
  digest,
} from "../fixtures/recordingCheckpoint";
import { history } from "../deployment/controlFixtures";
import { getDeploymentControlRepository } from "../../src/db";
import * as checkpoints from "../../src/services/recordingCheckpointService";
import { verifyStoredArtifact } from "../../src/services/storageService";
import { getVerifiedMeetingArtifacts } from "../../src/services/uploadService";
import { meetingArtifactProducers } from "../../src/services/meetingArtifactProducer";
import {
  reconcileMeetingTempDirectory,
  type CleanupMeeting,
} from "../../src/services/meetingArtifactCleanupService";
import { CLEANUP_RECEIPT_FILENAME } from "../../src/services/artifactCleanupReceipt";
import { createRecoveryArtifactScope } from "../../src/services/recoveryArtifactScope";
import * as tempFiles from "../../src/services/tempFileService";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "chronote-cleanup-flow-"));
});
afterEach(async () => {
  jest.restoreAllMocks();
  const producer = meetingArtifactProducers.get(directory);
  producer?.freeze();
  meetingArtifactProducers.release(directory);
  if (
    path.dirname(directory) !== path.resolve(tmpdir()) ||
    !path.basename(directory).startsWith("chronote-cleanup-flow-")
  )
    throw new Error("Unexpected test cleanup target");
  await fs.rm(directory, { recursive: true, force: true });
});

async function setup() {
  const f = fixture();
  const saved = await f.service.flush({
    ...input,
    captureState: {
      kind: "complete",
      startedAt: capture.captureStartedAt!,
      endedAt: "2026-01-01T00:00:04Z",
    },
  });
  if (saved.kind !== "committed") throw new Error("Checkpoint setup failed");
  const row = f.histories.get(history.guildId)![0];
  row.status = "complete";
  row.audioS3Key = `${saved.checkpoint.artifactFolder}audio_combined.mp3`;
  const finalBytes = Buffer.from("saved final audio");
  const reference = {
    key: row.audioS3Key,
    checksumSha256: digest(finalBytes),
    byteLength: finalBytes.length,
    versionId: "v1",
  };
  f.objects.set(reference.key, finalBytes);
  jest.mocked(getDeploymentControlRepository).mockReturnValue(f.repository);
  jest
    .spyOn(checkpoints, "createRecordingCheckpointService")
    .mockReturnValue(f.service);
  jest.mocked(getVerifiedMeetingArtifacts).mockReturnValue([reference]);
  jest.mocked(verifyStoredArtifact).mockImplementation(async (object) => {
    const value = f.objects.get(object.key);
    if (
      !value ||
      value.length !== object.byteLength ||
      digest(value) !== object.checksumSha256
    )
      throw new Error("Stored object verification failed");
  });
  const owner = {
    guildId: history.guildId,
    meetingId: history.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
  };
  const producer = meetingArtifactProducers.claim({ directory, owner });
  const filename = path.join(directory, "track.pcm");
  const write = producer.beginWrite(filename, {
    kind: "captured_audio",
    producer: "speaker_track",
  });
  await fs.writeFile(filename, bytes);
  write.settle("known");
  const meeting: CleanupMeeting = {
    meetingId: history.meetingId,
    recordingCheckpoint: saved.checkpoint,
    reservation: {
      ...owner,
      sessionMode: "meeting",
      historyKey: {
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      },
    },
  };
  return { ...f, row, meeting, producer, filename };
}

test("finalization uses actual checkpoint and local bytes before cleanup and permanently closes callbacks", async () => {
  const f = await setup();
  expect(await reconcileMeetingTempDirectory(directory, f.meeting)).toEqual({
    kind: "cleaned",
    removed: 1,
    byteLength: bytes.length,
  });
  await expect(fs.access(directory)).rejects.toThrow();
  expect(() =>
    f.producer.beginWrite(f.filename, { kind: "stored_input" }),
  ).toThrow("closed");
});

test("a failed first unlink becomes a durable retry without rerunning meeting processing", async () => {
  const f = await setup();
  const unlink = fs.unlink.bind(fs);
  const failure = jest
    .spyOn(fs, "unlink")
    .mockImplementation(async (filename) => {
      if (filename === f.filename) throw new Error("Cleanup refused");
      await unlink(filename);
    });
  try {
    expect(
      (await reconcileMeetingTempDirectory(directory, f.meeting)).kind,
    ).toBe("pending");
    await fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME));
    expect(await fs.readFile(f.filename)).toEqual(bytes);
  } finally {
    failure.mockRestore();
  }
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("cleaned");
  expect(f.row.status).toBe("complete");
});

test("a retry refuses a changed execution and leaves the retained payload intact", async () => {
  const f = await setup();
  const failure = jest
    .spyOn(fs, "unlink")
    .mockRejectedValue(new Error("Cleanup refused"));
  expect((await reconcileMeetingTempDirectory(directory, f.meeting)).kind).toBe(
    "pending",
  );
  failure.mockRestore();
  f.row.executionVersion = 2;
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("blocked");
  expect(await fs.readFile(f.filename)).toEqual(bytes);
});

test("failed verification retains provenance for a fresh receipt-only retry", async () => {
  const f = await setup();
  jest
    .mocked(verifyStoredArtifact)
    .mockRejectedValueOnce(new Error("Provider unavailable"));
  expect((await reconcileMeetingTempDirectory(directory, f.meeting)).kind).toBe(
    "blocked",
  );
  await fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME));
  expect(await fs.readFile(f.filename)).toEqual(bytes);
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("cleaned");
  expect(f.row.status).toBe("complete");
});

test("an unavailable initial history read cannot erase closed cleanup provenance", async () => {
  const f = await setup();
  jest
    .spyOn(f.repository, "getMeetingHistory")
    .mockRejectedValueOnce(new Error("History unavailable"));
  expect((await reconcileMeetingTempDirectory(directory, f.meeting)).kind).toBe(
    "blocked",
  );
  await fs.access(path.join(directory, CLEANUP_RECEIPT_FILENAME));
  expect(await fs.readFile(f.filename)).toEqual(bytes);
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("cleaned");
});

test("closed cancellation intent is not replaced by an unrelated complete history disposition", async () => {
  const f = await setup();
  const meeting = { ...f.meeting, cancelled: true };
  expect((await reconcileMeetingTempDirectory(directory, meeting)).kind).toBe(
    "blocked",
  );
  const receipt = JSON.parse(
    await fs.readFile(path.join(directory, CLEANUP_RECEIPT_FILENAME), "utf8"),
  );
  expect(receipt.decision).toBe("cancel");
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("blocked");
  expect(await fs.readFile(f.filename)).toEqual(bytes);
});

test("an initial ownership rejection retains original provenance without adopting the new owner", async () => {
  const f = await setup();
  f.row.executionVersion = 2;
  expect((await reconcileMeetingTempDirectory(directory, f.meeting)).kind).toBe(
    "blocked",
  );
  const receipt = JSON.parse(
    await fs.readFile(path.join(directory, CLEANUP_RECEIPT_FILENAME), "utf8"),
  );
  expect(receipt.owner.executionVersion).toBe(1);
  expect((await reconcileMeetingTempDirectory(directory)).kind).toBe("blocked");
  expect(await fs.readFile(f.filename)).toEqual(bytes);
});

test.each([true, false])(
  "recovery scratch cleanup requires its stored source bytes (%s)",
  async (sourceAvailable) => {
    const f = await setup();
    jest.spyOn(tempFiles, "ensureTempBaseDir").mockResolvedValue(directory);
    f.row.executionVersion = 2;
    f.row.status = "interrupted";
    const checkpoint = f.meeting.recordingCheckpoint!;
    const verified = await f.service.read(checkpoint);
    const source = verified.verified[0].object;
    const scope = await createRecoveryArtifactScope(
      {
        owner: {
          guildId: history.guildId,
          meetingId: history.meetingId,
          ownerInstanceId: "old",
          executionVersion: 2,
        },
        historyKey: history.channelId_timestamp,
        checkpoint,
      },
      [source],
    );
    const filename = path.join(scope.directory, "scratch.wav");
    const write = scope.beginWrite(filename);
    await fs.writeFile(filename, "derived audio");
    write.settle("uncertain");
    if (!sourceAvailable) f.objects.delete(source.key);
    expect((await scope.close()).kind).toBe(
      sourceAvailable ? "cleaned" : "blocked",
    );
    expect(await fs.readFile(f.filename)).toEqual(bytes);
    if (sourceAvailable) await expect(fs.access(filename)).rejects.toThrow();
    else {
      expect(await fs.readFile(filename, "utf8")).toBe("derived audio");
      await fs.access(path.join(scope.directory, CLEANUP_RECEIPT_FILENAME));
    }
  },
);
