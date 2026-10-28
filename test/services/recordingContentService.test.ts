/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/savedRecordingPrompt", () => ({
  ...jest.requireActual("../../src/services/savedRecordingPrompt"),
  snapshotRecordingPrompt: jest.fn(
    async (name: string, type: string, label: string) => ({
      name,
      type,
      label,
      version: 11,
      template:
        type === "text"
          ? "{{transcript}}"
          : [{ role: "user", content: "{{transcript}} {{notes}}" }],
    }),
  ),
}));
jest.mock("../../src/services/contextService", () => ({
  ...jest.requireActual("../../src/services/contextService"),
  collectMeetingContext: jest.fn(async () => ({
    availability: "available",
    data: { serverContext: "original generated context" },
  })),
}));
jest.mock("../../src/services/meetingNameService", () => ({
  listRecentMeetingNamesForPrompt: jest.fn(async () => "Original names"),
}));
jest.mock("prism-media", () => ({
  opus: { Decoder: jest.requireActual("node:stream").PassThrough },
}));
jest.mock("../../src/liveVoice", () => ({ maybeRespondLive: jest.fn() }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeSnippet: jest.fn(),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Recovered true tail",
  })),
}));
import {
  subscribeToUserVoice,
  userStartTalking,
  userStopTalking,
  clearSnippetTimer,
  startProcessingSnippet,
  stopRecordingCapture,
  waitForCaptureStreamSettlement,
} from "../../src/audio";
import { compileTranscriptions } from "../../src/services/transcriptCompilationService";
import { cleanupContentTranscription } from "../../src/services/transcriptionCleanupService";
jest.mock("../../src/services/transcriptionCleanupService", () => ({
  ...jest.requireActual("../../src/services/transcriptionCleanupService"),
  cleanupContentTranscription: jest.fn(),
}));
jest.mock("../../src/services/transcriptionPromptService", () => ({
  ...jest.requireActual("../../src/services/transcriptionPromptService"),
  getTranscriptionCleanupPrompt: jest.fn(async () => ({
    messages: [{ role: "system", content: "Synthetic cleanup prompt" }],
  })),
}));
import {
  transcribeSnippet,
  transcribeContentSnippet,
} from "../../src/services/transcriptionService";
import { recoverTranscript } from "../../src/services/meetingRecoveryContent";
import { recoveryFixture } from "./meetingRecoveryFixtures";
import { PassThrough } from "node:stream";
import { Collection } from "discord.js";
import { resolveMeetingRuntimeConfig } from "../../src/services/meetingConfigService";
import {
  startRecordingContentCheckpoint,
  checkpointCompletedTranscription,
  checkpointRecordingContext,
  captureRecordingTranscriptScope,
  guardRecordingFinalization,
} from "../../src/services/recordingContentService";
import { snapshotRecordingPrompt } from "../../src/services/savedRecordingPrompt";
import { collectMeetingContext } from "../../src/services/contextService";
import {
  generationContextSchema,
  completedTranscriptionSchema,
  savedRecordingSettingsSchema,
} from "../../src/types/recordingContent";
import type { MeetingData } from "../../src/types/meeting-data";
import type { CheckpointArtifactInput } from "../../src/types/recordingCheckpoint";

async function fixture(transcribeMeeting = true) {
  const artifacts: CheckpointArtifactInput[] = [];
  const runtimeConfig = await resolveMeetingRuntimeConfig({
    guildId: "generated",
    channelId: "voice",
    userId: "creator",
  });
  const meeting = {
    isAutoRecording: false,
    meetingId: "generated-meeting",
    guildId: "generated",
    channelId: "separate-notes",
    textChannel: { id: "separate-notes", send: jest.fn() },
    transcribeMeeting,
    generateNotes: true,
    captureStartedAt: new Date(2000),
    creator: { id: "creator" },
    runtimeConfig,
    reservation: {
      sessionMode: "meeting",
      meetingId: "generated-meeting",
      guildId: "generated",
      ownerInstanceId: "owner",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      reservedAt: 1000,
      historyKey: {
        guildId: "generated",
        channelId_timestamp: "voice#1970-01-01T00:00:01.000Z",
      },
    },
    ownershipSignal: new AbortController().signal,
    recordingCapture: {
      queueContent: (artifact: CheckpointArtifactInput) => {
        artifacts.push(artifact);
        return true;
      },
    },
    guild: {
      id: "generated",
      name: "Generated server",
      roles: new Collection(),
      scheduledEvents: new Collection(),
      channels: new Collection(),
      members: {},
      client: {},
    },
    voiceChannel: { id: "voice", name: "Generated voice" },
    participants: new Map([
      ["speaker", { id: "speaker", username: "Speaker" }],
    ]),
    attendance: new Set(["<@speaker>"]),
    chatLog: [],
    audioData: { audioFiles: [] },
  } as unknown as MeetingData;
  return { meeting, artifacts };
}

test("completedTranscriptionCheckpointSurvivesWithoutFinalization", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  meeting.audioData.audioFiles.push({
    userId: "speaker",
    timestamp: 2000,
    transcript: "Usable generated speech",
    processing: false,
    audioOnlyProcessing: false,
  });
  checkpointCompletedTranscription(meeting);
  const payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.entries[0].text).toBe("Usable generated speech");
  expect(payload.capture.channelId).toBe("voice");
  expect(meeting.channelId).toBe("separate-notes");
  expect(meeting.textChannel.id).toBe("separate-notes");
  expect(payload.capture.requested).toEqual({
    transcribeMeeting: true,
    generateNotes: true,
  });
  expect(meeting.finalization).toBeUndefined();
});

test("later model/context changes cannot rewrite original generation settings", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const before = generationContextSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  meeting.runtimeConfig!.modelChoices = { notes: "changed-later" };
  jest.mocked(collectMeetingContext).mockResolvedValueOnce({
    availability: "available",
    data: { serverContext: "changed history" },
  });
  checkpointRecordingContext(meeting);
  const after = generationContextSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(after.settings).toEqual(before.settings);
  expect(after.context).toEqual(before.context);
  expect(after.prompts.notes).toMatchObject({
    availability: "available",
    value: { version: 11 },
  });
  expect(() =>
    generationContextSchema.parse({
      ...after,
      connection: { secret: "forbidden" },
    }),
  ).toThrow();
});

test("legacy recording settings default speech detection to off", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const payload = generationContextSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.settings.availability).toBe("available");
  if (payload.settings.availability !== "available")
    throw new Error("Original recording settings unavailable");
  const { speechDetectionMode, ...legacyTranscription } =
    payload.settings.value.transcription;
  expect(speechDetectionMode).toBe("off");
  const legacySettings = savedRecordingSettingsSchema.parse({
    ...payload.settings.value,
    transcription: legacyTranscription,
  });
  expect(legacySettings.transcription.speechDetectionMode).toBe("off");
});

test("disabled generation does not fetch unused templates", async () => {
  jest.mocked(snapshotRecordingPrompt).mockClear();
  const { meeting } = await fixture(false);
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  expect(snapshotRecordingPrompt).not.toHaveBeenCalled();
});

test("late usable transcript caller publishes after PCM completion without changing capture facts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { createRecordingCheckpointCapture } =
    await import("../../src/services/recordingCheckpointCapture");
  const { createRecordingCheckpointService } =
    await import("../../src/services/recordingCheckpointService");
  const { createMockDeploymentControlRepository } =
    await import("../../src/repositories/deploymentControlRepository");
  const { history } = await import("../deployment/controlFixtures");
  const { meeting } = await fixture();
  const directory = mkdtempSync(path.join(tmpdir(), "late-content-"));
  const controller = new AbortController();
  meeting.ownershipSignal = controller.signal;
  const row = {
    ...history,
    guildId: meeting.guildId,
    channelId: meeting.voiceChannel.id,
    meetingId: meeting.meetingId,
    channelId_timestamp: meeting.reservation!.historyKey!.channelId_timestamp,
    timestamp: new Date(1000).toISOString(),
    ownerInstanceId: "owner",
    executionVersion: 1,
    status: "in_progress" as const,
  };
  const repository = createMockDeploymentControlRepository(
    new Map(),
    new Map([[meeting.guildId, [row]]]),
    new Map([
      [
        meeting.guildId,
        {
          guildId: meeting.guildId,
          meetingId: meeting.meetingId,
          ownerInstanceId: "owner",
          executionVersion: 1,
          voiceOperationAttemptId: "voice",
          sessionMode: "meeting",
          voiceChannelId: meeting.voiceChannel.id,
          textChannelId: meeting.textChannel.id,
          isAutoRecording: false,
          leaseExpiresAt: Math.floor(Date.now() / 1000) + 120,
          createdAt: row.timestamp,
          updatedAt: row.timestamp,
          expiresAt: 0,
        },
      ],
    ]),
  );
  const objects = new Map<string, Buffer>();
  const producer = createRecordingCheckpointService({
    repository,
    objects: {
      upload: async (key, bytes) => {
        if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
        return key;
      },
      read: async (key) => objects.get(key),
    },
  }).createProducerSession();
  let audioCommits = 0;
  meeting.recordingCapture = createRecordingCheckpointCapture({
    directory,
    startedAt: 2000,
    signal: controller.signal,
    commit: async (artifacts, signal) => {
      if (artifacts.some((artifact) => artifact.kind === "audio")) {
        audioCommits++;
        checkpointRecordingContext(meeting);
      }
      return (
        (
          await producer.appendArtifactsRecordingCheckpoint(
            meeting,
            [...artifacts],
            signal,
          )
        ).kind === "committed"
      );
    },
    stopCapture: jest.fn(),
  });
  try {
    meeting.recordingCaptureState = {
      kind: "capturing",
      startedAt: new Date(2000).toISOString(),
    };
    startRecordingContentCheckpoint(meeting);
    await meeting.recordingContentTask;
    expect(await meeting.recordingCapture.drainContent()).toBe(true);
    meeting.recordingCapture.push("user:speaker", Buffer.alloc(3840), 2000);
    const complete = {
      kind: "complete" as const,
      startedAt: new Date(2000).toISOString(),
      endedAt: new Date(3000).toISOString(),
    };
    meeting.recordingCaptureState = complete;
    expect(await meeting.recordingCapture.finish()).toBe(true);
    expect(audioCommits).toBe(1);
    const audioPointer = meeting.recordingCheckpoint!;
    meeting.audioData.audioFiles.push({
      userId: "speaker",
      timestamp: 2000,
      transcript: "Late usable speech",
      processing: false,
      audioOnlyProcessing: false,
    });
    checkpointCompletedTranscription(meeting);
    expect(await meeting.recordingCapture.drainContent()).toBe(true);
    const verified = await producer.read(meeting.recordingCheckpoint!);
    expect(verified.manifest.captureState).toEqual(complete);
    expect(verified.manifest.capture.channelId).toBe("voice");
    for (const artifact of verified.verified.filter(
      (item) => item.kind !== "audio",
    )) {
      expect(
        JSON.parse(objects.get(artifact.object.key)!.toString()).capture
          .channelId,
      ).toBe("voice");
    }
    expect(row.channelId).toBe("voice");
    expect(meeting.channelId).toBe("separate-notes");
    expect(meeting.textChannel.id).toBe("separate-notes");
    expect(meeting.recordingCheckpoint!.capture).toEqual(audioPointer.capture);
    const text = verified.verified
      .filter((artifact) => artifact.kind === "transcription")
      .at(-1)!;
    expect(
      JSON.parse(objects.get(text.object.key)!.toString()).entries[0].text,
    ).toBe("Late usable speech");
    const finalPointer = meeting.recordingCheckpoint;
    controller.abort();
    checkpointCompletedTranscription(meeting);
    await meeting.recordingCapture.settled();
    expect(meeting.recordingCheckpoint).toBe(finalPointer);
    expect(meeting.finalization).toBeUndefined();
    meeting.recordingCapture.releaseSettledBuffers();
  } finally {
    meeting.recordingCapture.fence();
    await meeting.recordingCapture.settled();
    meeting.recordingCapture.releaseSettledBuffers();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("snapshot settlement waits for every real lookup even when context fails first", async () => {
  const { meeting } = await fixture();
  jest
    .mocked(collectMeetingContext)
    .mockRejectedValueOnce(new Error("generated context unavailable"));
  let complete!: () => void;
  jest.mocked(snapshotRecordingPrompt).mockImplementationOnce(
    (name, type, label) =>
      new Promise((resolve) => {
        expect(type).toBe("text");
        complete = () =>
          resolve({
            name,
            type: "text",
            label,
            version: 1,
            template: "{{transcript}}",
          });
      }),
  );
  startRecordingContentCheckpoint(meeting);
  let settled = false;
  void meeting.recordingContentTask!.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  complete();
  await meeting.recordingContentTask;
  expect(settled).toBe(true);
});

test("selected fast prefix keeps its own byte receipt after full slow failure", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const prefix = {
    kind: "pcm" as const,
    spans: [
      { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 3840 },
    ],
  };
  meeting.audioData.audioFiles.push({
    userId: "speaker",
    timestamp: 2000,
    transcript: "retained prefix",
    transcriptCorrespondence: prefix,
    fastTranscripts: [
      {
        revision: 1,
        text: "retained prefix",
        createdAt: new Date().toISOString(),
        correspondence: prefix,
      },
    ],
    transcriptionFailed: true,
    processing: false,
    audioOnlyProcessing: false,
  });
  checkpointCompletedTranscription(meeting);
  const payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.entries).toHaveLength(1);
  expect(payload.entries[0]).toMatchObject({
    text: "retained prefix",
    correspondence: prefix,
  });
});

test.each([false, true])(
  "selected terminal empty disposition survives finalText=%s",
  async (finalized) => {
    const { meeting, artifacts } = await fixture();
    startRecordingContentCheckpoint(meeting);
    await meeting.recordingContentTask;
    const omitted = {
      kind: "pcm" as const,
      spans: [
        { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 3840 },
      ],
    };
    meeting.audioData.audioFiles.push({
      userId: "speaker",
      timestamp: 2000,
      slowTranscript: "",
      transcript: "",
      terminalOmission: omitted,
      processing: false,
      audioOnlyProcessing: false,
    });
    if (finalized)
      captureRecordingTranscriptScope(meeting, meeting.audioData.audioFiles);
    checkpointCompletedTranscription(
      meeting,
      finalized
        ? { finalPass: "acknowledged", cleanup: "disabled", finalText: "" }
        : undefined,
    );
    const payload = completedTranscriptionSchema.parse(
      JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
    );
    expect(payload.entries).toEqual([]);
    expect(payload.omitted).toEqual(omitted);
    if (finalized)
      expect(payload.processing).toEqual({
        finalPass: "acknowledged",
        cleanup: "disabled",
        finalText: "",
        correspondence: omitted,
      });
  },
);

function lastTranscript(artifacts: CheckpointArtifactInput[]) {
  const item = artifacts.filter((item) => item.kind === "transcription").at(-1);
  if (!item) throw new Error("Missing transcript checkpoint");
  return completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(item.bytes).toString()),
  );
}
test("failed finalization keeps immutable pre-pass baseline and sole late text evidence", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const baseline = {
    userId: "speaker",
    timestamp: 2000,
    transcript: "Original pre-pass words",
    transcriptCorrespondence: {
      kind: "pcm" as const,
      spans: [
        { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 3840 },
      ],
    },
    processing: false,
    audioOnlyProcessing: false,
  };
  meeting.audioData.audioFiles.push(baseline);
  checkpointCompletedTranscription(meeting);
  guardRecordingFinalization(meeting);
  Object.assign(baseline, { finalPassTranscript: "Mutated finalized words" });
  const before = artifacts.length;
  checkpointCompletedTranscription(meeting);
  expect(artifacts).toHaveLength(before);
  const late = {
    userId: "speaker",
    timestamp: 3000,
    source: "chat_tts" as const,
    transcript: "Sole late TTS text",
    transcriptCorrespondence: { kind: "text_only" as const },
    processing: false,
    audioOnlyProcessing: false,
  };
  meeting.audioData.audioFiles.push(late);
  checkpointCompletedTranscription(meeting);
  expect(lastTranscript(artifacts).entries.map((entry) => entry.text)).toEqual([
    "Original pre-pass words",
    "Sole late TTS text",
  ]);
  expect(lastTranscript(artifacts).processing).toBeUndefined();
  Object.assign(late, { finalPassTranscript: "Later mutable output" });
  checkpointCompletedTranscription(meeting);
  expect(lastTranscript(artifacts).entries.map((entry) => entry.text)).toEqual([
    "Original pre-pass words",
    "Sole late TTS text",
  ]);
});
test.each(["pcm", "text_only"] as const)(
  "acknowledged aggregate cannot widen or regress when late %s input arrives",
  async (kind) => {
    const { meeting, artifacts } = await fixture();
    startRecordingContentCheckpoint(meeting);
    await meeting.recordingContentTask;
    const first = {
      userId: "speaker",
      timestamp: 2000,
      transcript: "Compile input",
      transcriptCorrespondence: {
        kind: "pcm" as const,
        spans: [
          {
            sourceId: "user:speaker",
            sequence: 0,
            startByte: 0,
            endByte: 3840,
          },
        ],
      },
      processing: false,
      audioOnlyProcessing: false,
    };
    meeting.audioData.audioFiles.push(first);
    guardRecordingFinalization(meeting);
    captureRecordingTranscriptScope(meeting, [first]);
    meeting.audioData.audioFiles.push({
      userId: "speaker",
      timestamp: 3000,
      transcript: "Late cleanup input",
      transcriptCorrespondence:
        kind === "text_only"
          ? { kind }
          : {
              kind,
              spans: [
                {
                  sourceId: "user:speaker",
                  sequence: 0,
                  startByte: 3840,
                  endByte: 7680,
                },
              ],
            },
      processing: false,
      audioOnlyProcessing: false,
    });
    checkpointCompletedTranscription(meeting, {
      finalPass: "acknowledged",
      cleanup: "acknowledged",
      finalText: "  exact aggregate\n",
    });
    const result = lastTranscript(artifacts);
    expect(result.processing).toEqual({
      finalPass: "acknowledged",
      cleanup: "acknowledged",
      finalText: "  exact aggregate\n",
      correspondence: first.transcriptCorrespondence,
      supplementalEntries: true,
    });
    checkpointCompletedTranscription(meeting);
    expect(lastTranscript(artifacts).processing).toEqual(result.processing);
    expect(
      lastTranscript(artifacts).entries.map((entry) => entry.text),
    ).toEqual(["Compile input", "Late cleanup input"]);
  },
);

test.each(["failed", "skipped"] as const)(
  "actual receiver checkpoint preserves finalized %s disposition during recovery",
  async (status) => {
    jest.useFakeTimers();
    jest.setSystemTime(2000);
    const { meeting, artifacts } = await fixture();
    const { createRecordingCheckpointCapture } =
      await import("../../src/services/recordingCheckpointCapture");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const directory = mkdtempSync(path.join(tmpdir(), "mapped-producer-"));
    const pcm: CheckpointArtifactInput[] = [];
    meeting.audioData.currentSnippets = new Map();
    const stream = new PassThrough();
    Object.assign(meeting, {
      connection: {
        state: { status: "ready" },
        receiver: {
          packetDiagnostics: new WeakMap(),
          subscriptions: new Map(),
          subscribe: () => stream,
        },
      },
      captureAudio: true,
      startTime: new Date(2000),
    });
    meeting.recordingCapture = createRecordingCheckpointCapture({
      directory,
      startedAt: 2000,
      signal: meeting.ownershipSignal!,
      commit: async (items) => {
        pcm.push(...items);
        return true;
      },
      stopCapture: jest.fn(),
    });
    // Keep generated context artifacts visible while the real capture queues publication.
    const queueContent = meeting.recordingCapture.queueContent.bind(
      meeting.recordingCapture,
    );
    meeting.recordingCapture.queueContent = (item) => {
      artifacts.push(item);
      return queueContent(item);
    };
    let resolveFast!: (result: {
      status: "succeeded";
      text: string;
      admission: { kind: "not_enforced"; reason: "off" };
    }) => void;
    jest
      .mocked(transcribeSnippet)
      .mockImplementationOnce(async (_meeting, snapshot) => {
        expect(snapshot.pcmSpans).toEqual([
          {
            sourceId: "user:speaker",
            sequence: 0,
            startByte: 0,
            endByte: 61440,
          },
        ]);
        return new Promise((resolve) => {
          resolveFast = resolve;
        });
      })
      .mockResolvedValueOnce(
        status === "failed"
          ? { status: "failed", reason: "transcription_error" }
          : {
              status: "skipped",
              reason: "non_speech",
              coverage: {
                pcmSha256: "a".repeat(64),
                audioBytes: 65280,
                policyFingerprint: "saved-policy",
              },
            },
      );
    try {
      startRecordingContentCheckpoint(meeting);
      await meeting.recordingContentTask;
      await subscribeToUserVoice(meeting, "speaker");
      userStartTalking(meeting, "speaker");
      stream.write(Buffer.alloc(61440, 1));
      userStopTalking(meeting, "speaker");
      await jest.advanceTimersByTimeAsync(
        meeting.runtimeConfig!.transcription.fastSilenceMs,
      );
      stream.write(Buffer.alloc(3840, 2));
      resolveFast({
        status: "succeeded",
        text: "Saved immutable prefix",
        admission: { kind: "not_enforced", reason: "off" },
      });
      await jest.advanceTimersByTimeAsync(0);
      clearSnippetTimer(meeting, "speaker");
      startProcessingSnippet(meeting, "speaker");
      await jest.advanceTimersByTimeAsync(0);
      await meeting.audioData.audioFiles[0].processingPromise;
      checkpointCompletedTranscription(meeting);
      const saved = lastTranscript(artifacts);
      if (status === "failed")
        expect(saved.entries[0].correspondence).toEqual({
          kind: "pcm",
          spans: [
            {
              sourceId: "user:speaker",
              sequence: 0,
              startByte: 0,
              endByte: 61440,
            },
          ],
        });
      else {
        expect(saved.entries).toEqual([]);
        expect(saved.omitted).toEqual({
          kind: "pcm",
          spans: [
            {
              sourceId: "user:speaker",
              sequence: 0,
              startByte: 0,
              endByte: 65280,
            },
          ],
        });
        expect(
          meeting.audioData.audioFiles[0].finalSpeechRejection,
        ).toMatchObject({
          policyFingerprint: "saved-policy",
        });
      }
      await meeting.recordingCapture.finish();
      jest.useRealTimers();
      const f = await recoveryFixture("", {
        artifacts: pcm.filter((item) => item.kind === "audio"),
        transcript: (payload) => {
          payload.entries = saved.entries;
          payload.omitted = saved.omitted;
        },
        context: (context) => {
          if (context.settings.availability !== "available")
            throw new Error("settings");
          context.settings.value.transcription.finalPassEnabled = false;
          context.settings.value.premiumTranscription = {
            enabled: false,
            cleanupEnabled: false,
          };
          context.prompts.transcription = {
            availability: "available",
            value: {
              name: "original",
              version: 1,
              label: "original",
              type: "text",
              template: "Original",
            },
          };
        },
      });
      const { readRecoveryContent } =
        await import("../../src/services/meetingRecoveryContent");
      const content = await readRecoveryContent(
        f.claim.history,
        f.reader,
        meeting.ownershipSignal!,
      );
      const beforeRecoveryRequests = jest.mocked(transcribeContentSnippet).mock
        .calls.length;
      const result = await recoverTranscript(
        content,
        f.reader,
        meeting.ownershipSignal!,
        (run) => run(),
      );
      if (status === "failed") {
        expect(
          jest.mocked(transcribeContentSnippet).mock.calls.at(-1)![1].chunks[0],
        ).toEqual(Buffer.alloc(3840, 2));
        expect(result.text.match(/Saved immutable prefix/g)).toHaveLength(1);
        expect(result.segments).toHaveLength(2);
      } else {
        expect(result).toEqual({ text: "", segments: [] });
        expect(jest.mocked(transcribeContentSnippet).mock.calls).toHaveLength(
          beforeRecoveryRequests,
        );
      }
    } finally {
      clearSnippetTimer(meeting, "speaker");
      stopRecordingCapture(meeting);
      await waitForCaptureStreamSettlement(meeting);
      meeting.recordingCapture.fence();
      await meeting.recordingCapture.settled();
      meeting.recordingCapture.releaseSettledBuffers();
      rmSync(directory, { recursive: true, force: true });
      jest.useRealTimers();
    }
  },
);
test("actual compile freezes selected membership before asynchronous cleanup", async () => {
  const { meeting, artifacts } = await fixture();
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  Object.assign(meeting.guild.members, { cache: new Map() });
  const first = {
    userId: "speaker",
    timestamp: 2000,
    transcript: "Original input",
    transcriptCorrespondence: { kind: "text_only" as const },
    processing: false,
    audioOnlyProcessing: false,
  };
  meeting.audioData.audioFiles.push(first);
  Object.assign(meeting.runtimeConfig!.premiumTranscription, {
    enabled: true,
    cleanupEnabled: true,
  });
  let complete!: (text: string) => void;
  let executionEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    executionEntered = resolve;
  });
  jest.mocked(cleanupContentTranscription).mockImplementationOnce(() => {
    executionEntered();
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  guardRecordingFinalization(meeting);
  const compiled = compileTranscriptions(
    { users: { cache: new Map() } } as never,
    meeting,
  );
  await entered;
  meeting.audioData.audioFiles.push({
    userId: "speaker",
    timestamp: 3000,
    transcript: "Outside held cleanup",
    transcriptCorrespondence: { kind: "text_only" },
    processing: false,
    audioOnlyProcessing: false,
  });
  complete("Cleaned input");
  const finalText = await compiled;
  checkpointCompletedTranscription(meeting, {
    finalText,
    finalPass: "disabled",
    cleanup: "acknowledged",
  });
  expect(finalText).not.toContain("Outside held cleanup");
  expect(lastTranscript(artifacts).processing).toMatchObject({
    finalText,
    correspondence: { kind: "text_only" },
    supplementalEntries: true,
  });
});
