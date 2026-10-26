import { createHash } from "node:crypto";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";
import { history } from "../deployment/controlFixtures";
import type { RecordingCaptureProvenance } from "../../src/types/recordingCheckpoint";
export const capture: RecordingCaptureProvenance = {
  guildId: history.guildId,
  channelId: history.channelId,
  channelId_timestamp: history.channelId_timestamp,
  meetingId: history.meetingId,
  ownerInstanceId: "old",
  executionVersion: 1,
  reservedAt: history.timestamp,
  requested: { transcribeMeeting: true, generateNotes: true },
  captureStartedAt: "2026-01-01T00:00:02.000Z",
};
export const bytes = Buffer.alloc(96000);
export const digest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const segment = {
  kind: "audio" as const,
  format: { encoding: "pcm_s16le" as const, sampleRate: 48000, channels: 1 },
  sourceId: "speaker",
  sequence: 0,
  coverage: {
    kind: "known" as const,
    intervals: [{ sourceId: "speaker", startOffsetMs: 0, durationMs: 1000 }],
  },
  contentType: "audio/ogg",
  bytes,
  checksumSha256: digest(bytes),
};
export const ownership = {
  guildId: history.guildId,
  meetingId: history.meetingId,
  ownerInstanceId: "old",
  executionVersion: 1,
  voiceOperationAttemptId: "voice",
  sessionMode: "meeting" as const,
};
export function fixture() {
  const histories = new Map([[history.guildId, [{ ...history }]]]);
  const leases = new Map([
    [
      history.guildId,
      {
        ...ownership,
        voiceChannelId: "channel",
        textChannelId: "text",
        isAutoRecording: false,
        leaseExpiresAt: Math.floor(Date.now() / 1000) + 60,
        createdAt: history.timestamp,
        updatedAt: history.timestamp,
        expiresAt: 0,
      },
    ],
  ]);
  const repository = createMockDeploymentControlRepository(
    new Map(),
    histories,
    leases,
  );
  const objects = new Map<string, Buffer>();
  const upload = jest.fn(
    async (
      key: string,
      body: string | Uint8Array,
    ): Promise<string | undefined> => {
      if (!objects.has(key)) objects.set(key, Buffer.from(body));
      return key;
    },
  );
  const read = jest.fn(async (key: string) => objects.get(key));
  const service = createRecordingCheckpointService({
    repository,
    objects: { upload, read },
  });
  return { service, repository, objects, upload, read, histories, leases };
}
export const input = {
  capture,
  expectedStatus: "starting" as const,
  previous: undefined,
  artifacts: [segment],
};
