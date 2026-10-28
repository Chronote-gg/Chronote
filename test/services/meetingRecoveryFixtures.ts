import { createHash } from "node:crypto";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";
import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import {
  generationContextSchema,
  completedTranscriptionSchema,
} from "../../src/types/recordingContent";
import {
  history,
  control,
  context,
  runtime,
} from "../deployment/controlFixtures";
import type { MeetingHistory, ActiveMeetingLease } from "../../src/types/db";
import type { CheckpointArtifactInput } from "../../src/types/recordingCheckpoint";
/** A 48 kHz stereo PCM checkpoint piece whose intervals all bind `sourceId`. */
export function pcmArtifact(
  sourceId: string,
  sequence: number,
  bytes: Buffer,
  intervals: Array<{ startOffsetMs: number; durationMs: number }>,
): CheckpointArtifactInput {
  return {
    kind: "audio",
    sourceId,
    sequence,
    contentType: "audio/pcm",
    format: { encoding: "pcm_s16le", sampleRate: 48000, channels: 2 },
    coverage: {
      kind: "known",
      intervals: intervals.map((interval) => ({ sourceId, ...interval })),
    },
    bytes,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
/** Saves the text transcription prompt that recovery re-transcription requires. */
export function savedTranscriptionPrompt(
  saved: ReturnType<typeof generationContextSchema.parse>,
) {
  saved.prompts.transcription = {
    availability: "available",
    value: {
      name: "original",
      type: "text",
      label: "original",
      version: 1,
      template: "Saved transcription prompt",
    },
  };
}
export async function recoveryFixture(
  text = "We agreed to finish the release testing tomorrow.",
  options: {
    guildId?: string;
    nowMs?: number;
    requested?: { transcribeMeeting: boolean; generateNotes: boolean };
    artifacts?: CheckpointArtifactInput[];
    context?: (
      context: ReturnType<typeof generationContextSchema.parse>,
    ) => void;
    transcript?: (
      transcript: ReturnType<typeof completedTranscriptionSchema.parse>,
    ) => void;
  } = {},
) {
  const nowMs = options.nowMs ?? Date.now();
  const now = Math.floor(nowMs / 1000);
  const row: MeetingHistory = {
    ...history,
    guildId: options.guildId ?? history.guildId,
    participants: [],
    textChannelId: "text",
    ...(options.requested ?? {}),
  };
  const histories = new Map([[row.guildId, [row]]]);
  const ownership = {
    guildId: row.guildId,
    meetingId: row.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "original-voice",
    sessionMode: "meeting" as const,
  };
  const leases = new Map<string, ActiveMeetingLease>([
    [
      row.guildId,
      {
        ...ownership,
        voiceChannelId: row.channelId,
        textChannelId: "text",
        isAutoRecording: false,
        leaseExpiresAt: now + 60,
        createdAt: row.timestamp,
        updatedAt: row.timestamp,
        expiresAt: now + 120,
      },
    ],
  ]);
  const records = new Map();
  const repository = createMockDeploymentControlRepository(
    records,
    histories,
    leases,
  );
  const current = { ...control, coordinatorExpiresAt: now + 100 };
  await repository.initializeControl(current);
  const member = runtime("old");
  member.readiness!.expiresAt = now + 100;
  member.protection!.expiresAt = now + 100;
  await repository.writeRuntime(member);
  const objects = new Map<string, Buffer>();
  const upload = jest.fn(async (key: string, body: string | Uint8Array) => {
    objects.set(key, Buffer.from(body));
    return key;
  });
  const reader = createRecordingCheckpointService({
    repository,
    objects: { upload, read: async (key) => objects.get(key) },
  });
  const capture = {
    guildId: row.guildId,
    channelId: row.channelId,
    channelId_timestamp: row.channelId_timestamp,
    meetingId: row.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    reservedAt: row.timestamp,
    captureStartedAt: row.timestamp,
    requested: options.requested ?? {
      transcribeMeeting: true,
      generateNotes: true,
    },
  };
  const runtimeConfig = await resolveMeetingRuntimeConfig({
    guildId: row.guildId,
    channelId: row.channelId,
    userId: "123",
  });
  const model = {
    model: "original-model",
    provider: "openai" as const,
    params: {},
  };
  const prompt = {
    availability: "available" as const,
    value: {
      type: "chat" as const,
      name: "original",
      label: "original",
      version: 12,
      template: [
        {
          role: "user" as const,
          content: "{{formattedContext}} {{transcript}} {{notes}}",
        },
      ],
    },
  };
  const payload = generationContextSchema.parse({
    schemaVersion: 1,
    kind: "generation_context",
    capture,
    capturedAt: row.timestamp,
    creatorId: "123",
    serverName: "Saved server",
    serverDescription: "Saved description",
    voiceChannelName: "Saved channel",
    events: "Saved events",
    channelNames: "Saved channels",
    botDisplayName: "Saved bot",
    botNames: ["Saved bot"],
    tags: [],
    participants: [{ id: "123", username: "Speaker" }],
    attendance: ["<@123>"],
    promptVisibleRoleIds: ["456"],
    mentionableRoles: [{ id: "456", name: "Role" }],
    chatContext: "",
    participantRoster: "<@123>",
    roleRoster: "<@&456>",
    attendees: "<@123>",
    settings: {
      availability: "available",
      value: {
        models: {
          notes: model,
          meetingSummary: model,
          transcription: model,
          transcriptionCleanup: model,
          transcriptionCoalesce: model,
        },
        transcription: runtimeConfig.transcription,
        premiumTranscription: runtimeConfig.premiumTranscription,
        dictionary: runtimeConfig.dictionary,
        visionCaptions: runtimeConfig.visionCaptions,
        notes: {
          longStoryTestMode: false,
          longStoryTargetChars: 1,
          contextTestMode: false,
          enableMemory: false,
          memoryDepth: 0,
          maxContextLength: 1000,
        },
      },
    },
    context: {
      availability: "available",
      recentMeetings: [],
      formattedContext: "Original context",
      dictionaryEntries: [],
    },
    recentMeetingNames: { availability: "available", value: "Original names" },
    prompts: { notes: prompt, summary: prompt },
  });
  const transcript = completedTranscriptionSchema.parse({
    schemaVersion: 1,
    kind: "completed_transcription",
    capture,
    capturedAt: row.timestamp,
    entries: text
      ? [
          {
            sourceId: "user:123",
            userId: "123",
            source: "voice",
            timestamp: Date.parse(row.timestamp),
            text,
            speakerLabel: "Speaker",
            completedAt: row.timestamp,
            revision: 0,
          },
        ]
      : [],
  });
  function artifact(
    kind: "context" | "transcription",
    value: unknown,
  ): CheckpointArtifactInput {
    const bytes = Buffer.from(JSON.stringify(value));
    return {
      kind,
      sourceId: kind,
      sequence: 1,
      contentType: "application/json",
      coverage: { kind: "unknown" },
      bytes,
      checksumSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  options.context?.(payload);
  options.transcript?.(transcript);
  const result = await reader.flush({
    signal: new AbortController().signal,
    ownership,
    capture,
    captureState: { kind: "capturing", startedAt: row.timestamp },
    expectedStatus: "starting",
    previous: undefined,
    artifacts: [
      artifact("context", payload),
      artifact("transcription", transcript),
      ...(options.artifacts ?? []),
    ],
  });
  if (result.kind !== "committed")
    throw new Error("Fixture checkpoint was not committed");
  leases.delete(row.guildId);
  const claim = await repository.claimRecordingRecovery({
    history: (await repository.getMeetingHistory(row))!,
    lease: undefined,
    context: { ...context, now },
    attemptId: "generated-recovery",
  });
  if (!claim) throw new Error("Fixture recovery claim failed");
  return {
    records,
    repository,
    reader,
    objects,
    upload,
    claim,
    payload,
    transcript,
    leases,
    now,
    nowMs,
    context: { ...context, now },
    histories,
  };
}
