import {
  speechRejectionSchema,
  type SpeechRejection,
} from "../types/speechRejection";
import type { AudioSnippet } from "../types/audio";
import type { SpeechCoverage, SpeechPhase } from "./speechDetectionTypes";
import { recordingPromptLabels } from "./recordingMetadataService";
import {
  isFixture,
  fixtureLabels,
  fixtureParticipants,
} from "./fixtureInputService";
import type { AudioFileData } from "../types/audio";
import type { TranscriptCorrespondence } from "../types/transcriptCorrespondence";
import {
  combineCorrespondence,
  copyCorrespondence,
} from "../utils/transcriptCorrespondence";
import { liveTranscriptionProcessingSettings } from "./transcriptionProcessingSettings";
import {
  freezeCompletionPolicy,
  completionSnapshot,
} from "./meetingCompletionPolicyService";
import { createHash } from "node:crypto";
import type { MeetingData } from "../types/meeting-data";
import type { RecordingCaptureProvenance } from "../types/recordingCheckpoint";
import {
  generationContextSchema,
  completedTranscriptionSchema,
  savedRecordingSettingsSchema,
  type GenerationContextCheckpoint,
  type SavedRecordingSettings,
  type CompletedTranscriptionCheckpoint,
} from "../types/recordingContent";
import {
  collectMeetingContext,
  formatContextForPrompt,
} from "./contextService";
import { config } from "./configService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { snapshotRecordingPrompt } from "./savedRecordingPrompt";
import {
  formatChatLogForPrompt,
  formatParticipantRoster,
  formatRoleRoster,
  isMentionableRole,
  selectRolesForPrompt,
} from "./notesPromptService";

import { formatParticipantLabel } from "../utils/participants";
import { getBotNameVariants } from "../utils/botNames";
import { resolveAudioFileTranscript } from "../utils/audioTranscript";
import { listRecentMeetingNamesForPrompt } from "./meetingNameService";

type Frozen = Pick<
  GenerationContextCheckpoint,
  "capture" | "settings" | "context" | "prompts" | "recentMeetingNames"
> & {
  rejections: Map<string, SpeechRejection>;
  rejectionEvidenceIncomplete: boolean;
  sequence: number;
  phase: "capturing" | "finalizing" | "finalized";
  prePass?: {
    files: Set<AudioFileData>;
    entries: CompletedTranscriptionCheckpoint["entries"];
    omitted?: TranscriptCorrespondence;
    supplemental: Map<AudioFileData, ReturnType<typeof selectFile>>;
  };
  aggregate?: {
    files: Map<AudioFileData, string>;
    correspondence?: TranscriptCorrespondence;
  };
  processing?: CompletedTranscriptionCheckpoint["processing"];
};
const snapshots = new WeakMap<MeetingData, Frozen>();
function provenance(meeting: MeetingData): RecordingCaptureProvenance {
  const reservation = meeting.reservation;
  if (
    !reservation ||
    reservation.sessionMode !== "meeting" ||
    !meeting.captureStartedAt
  )
    throw new Error("Recording capture is not attached");
  return {
    ...reservation.historyKey,
    meetingId: reservation.meetingId,
    channelId: meeting.voiceChannel.id,
    ownerInstanceId: reservation.ownerInstanceId,
    executionVersion: reservation.executionVersion,
    reservedAt: new Date(reservation.reservedAt).toISOString(),
    captureStartedAt: meeting.captureStartedAt.toISOString(),
    requested: {
      transcribeMeeting: meeting.transcribeMeeting,
      generateNotes: meeting.generateNotes,
    },
  };
}
function settings(meeting: MeetingData): SavedRecordingSettings {
  const runtime = meeting.runtimeConfig;
  if (!runtime) throw new Error("Original recording settings unavailable");
  const model = (
    role:
      | "notes"
      | "meetingSummary"
      | "transcription"
      | "transcriptionCleanup"
      | "transcriptionCoalesce",
  ) => {
    const choice = getModelChoice(role, getMeetingModelOverrides(meeting));
    return {
      ...choice,
      params:
        role === "transcription"
          ? {}
          : resolveChatParamsForRole({
              role,
              model: choice.model,
              config: runtime.modelParams?.[role],
            }),
    };
  };
  return savedRecordingSettingsSchema.parse({
    autoCompletion: freezeCompletionPolicy(meeting),
    processing: liveTranscriptionProcessingSettings,
    models: {
      notes: model("notes"),
      meetingSummary: model("meetingSummary"),
      transcription: model("transcription"),
      transcriptionCleanup: model("transcriptionCleanup"),
      transcriptionCoalesce: model("transcriptionCoalesce"),
    },
    transcription: runtime.transcription,
    premiumTranscription: runtime.premiumTranscription,
    dictionary: runtime.dictionary,
    visionCaptions: runtime.visionCaptions,
    notes: {
      longStoryTestMode: config.notes.longStoryTestMode,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      contextTestMode: config.context.testMode,
      enableMemory: config.context.enableMemory,
      memoryDepth: config.context.memoryDepth,
      maxContextLength: config.context.maxContextLength,
    },
  });
}
function snapshotDynamic(
  meeting: MeetingData,
  frozen: Frozen,
): GenerationContextCheckpoint {
  const fixture = isFixture(meeting);
  const selected =
    fixtureParticipants(meeting) ?? Array.from(meeting.participants.values());
  const participants = Array.from(selected, (p) => ({
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    serverNickname: p.serverNickname,
    tag: p.tag,
    roleIds: p.roleIds,
  }));
  const roles = fixture
    ? []
    : meeting.guild.roles
        .valueOf()
        .filter((role) => isMentionableRole(role, meeting.guildId))
        .map((role) => ({ id: role.id, name: role.name }));
  return generationContextSchema.parse({
    schemaVersion: 1,
    kind: "generation_context",
    capture: frozen.capture,
    capturedAt: new Date().toISOString(),
    completion: completionSnapshot(meeting),
    captureIncomplete: meeting.audioData.captureIncomplete,
    creatorId: meeting.creator.id,
    ...recordingPromptLabels(meeting),
    botNames: fixture
      ? [fixtureLabels.botDisplayName]
      : getBotNameVariants(meeting.guild.members.me, meeting.guild.client.user),
    tags: fixture ? [] : [...(meeting.tags ?? [])],
    participants,
    attendance: [...meeting.attendance],
    mentionableRoles: roles,
    promptVisibleRoleIds: selectRolesForPrompt(roles, participants).map(
      (role) => role.id,
    ),
    participantRoster:
      formatParticipantRoster(
        participants,
        new Map(roles.map((role) => [role.id, role.name])),
      ) ?? "No participant roster captured.",
    roleRoster: formatRoleRoster(roles, participants),
    chatContext: fixture
      ? ""
      : (formatChatLogForPrompt({
          chatLog: meeting.chatLog,
          runtimeConfig:
            frozen.settings.availability === "available" &&
            meeting.runtimeConfig
              ? {
                  ...meeting.runtimeConfig,
                  visionCaptions: frozen.settings.value.visionCaptions,
                }
              : undefined,
        }) ?? ""),
    settings: frozen.settings,
    context: frozen.context,
    prompts: frozen.prompts,
    recentMeetingNames: frozen.recentMeetingNames,
  });
}
function enqueue(
  meeting: MeetingData,
  frozen: Frozen,
  kind: "context" | "transcription",
  payload: unknown,
) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const accepted = meeting.recordingCapture?.queueContent({
    kind,
    sourceId: kind,
    sequence: frozen.sequence++,
    contentType: "application/json",
    coverage: { kind: "unknown" },
    bytes,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (accepted === false && frozen.rejections.size) {
    frozen.rejectionEvidenceIncomplete = true;
    console.error("Speech rejection review checkpoint was not accepted.");
  }
}
export function checkpointRecordingContext(meeting: MeetingData): void {
  const frozen = snapshots.get(meeting);
  if (!frozen || !meeting.recordingCapture) return;
  enqueue(meeting, frozen, "context", snapshotDynamic(meeting, frozen));
}
function selectFile(file: AudioFileData) {
  const selected = resolveAudioFileTranscript(file);
  return {
    file,
    text: selected.text,
    correspondence: copyCorrespondence(selected.correspondence),
    settled: !file.processing,
    revision: file.fastTranscripts?.length ?? 0,
  };
}
function snapshotEntries(
  meeting: MeetingData,
  selected: ReturnType<typeof selectFile>[],
  completedAt: string,
): CompletedTranscriptionCheckpoint["entries"] {
  return selected.flatMap(({ file, text, correspondence, revision }) =>
    !text
      ? []
      : [
          {
            sourceId: `${file.source === "bot" || file.source === "chat_tts" ? "bot" : "user"}:${file.userId}`,
            userId: file.userId,
            source: file.source ?? "voice",
            timestamp: file.timestamp,
            text,
            correspondence: copyCorrespondence(correspondence),
            speakerLabel: formatParticipantLabel(
              meeting.participants.get(file.userId),
              { includeUsername: true, fallbackName: file.userId },
            ),
            completedAt,
            revision,
          },
        ],
  );
}
function snapshotOmissions(selected: ReturnType<typeof selectFile>[]) {
  const values = selected
    .filter((item) => !item.text && item.settled && item.correspondence)
    .map((item) => item.correspondence);
  return values.length ? combineCorrespondence(values) : undefined;
}
/** Seal opportunistic snapshots before mutable finalized-stage output exists. */
export function guardRecordingFinalization(meeting: MeetingData): void {
  const frozen = snapshots.get(meeting);
  if (frozen?.phase !== "capturing") return;
  const selected = meeting.audioData.audioFiles.map(selectFile);
  frozen.prePass = {
    files: new Set(meeting.audioData.audioFiles),
    entries: snapshotEntries(meeting, selected, new Date().toISOString()),
    omitted: snapshotOmissions(selected),
    supplemental: new Map(),
  };
  frozen.phase = "finalizing";
}
/** Called at the exact synchronous selection boundary before asynchronous cleanup. */
export function captureRecordingTranscriptScope(
  meeting: MeetingData,
  files: readonly AudioFileData[],
): void {
  const frozen = snapshots.get(meeting);
  if (!frozen || frozen.phase === "finalized") return;
  const selected = files.map((file) => ({
    file,
    ...resolveAudioFileTranscript(file),
  }));
  frozen.aggregate = {
    files: new Map(selected.map((item) => [item.file, item.text])),
    correspondence: combineCorrespondence(
      selected
        .filter(
          (item) => item.text || (!item.file.processing && item.correspondence),
        )
        .map((item) => item.correspondence),
    ),
  };
}
/** Preserve new late input beside the immutable pre-pass baseline while guarded. */
function snapshotGuardedTranscription(
  meeting: MeetingData,
  baseline: Frozen["prePass"],
  selected: ReturnType<typeof selectFile>[],
  completedAt: string,
) {
  if (!baseline) return;
  for (const item of selected) {
    if (
      !baseline.files.has(item.file) &&
      !baseline.supplemental.has(item.file) &&
      (item.text || (item.settled && item.correspondence))
    )
      baseline.supplemental.set(item.file, item);
  }
  if (!baseline.supplemental.size) return;
  // Preserve sole late text without publishing mutable baseline final-pass output.
  selected = [...baseline.supplemental.values()];
  const entries = [
    ...baseline.entries,
    ...snapshotEntries(meeting, selected, completedAt),
  ];
  const lateOmitted = snapshotOmissions(selected);
  const omitted =
    baseline.omitted && lateOmitted
      ? combineCorrespondence([baseline.omitted, lateOmitted])
      : (baseline.omitted ?? lateOmitted);
  return { selected, entries, omitted };
}
/** Supplemental evidence is sticky and never widens acknowledged aggregate scope. */
function markSupplementalTranscriptEntries(
  frozen: Frozen,
  selected: ReturnType<typeof selectFile>[],
) {
  const aggregate = frozen.aggregate;
  const supplemental =
    aggregate &&
    selected.some(
      (item) =>
        item.text &&
        (!aggregate.files.has(item.file) ||
          aggregate.files.get(item.file) !== item.text),
    );
  if (supplemental && frozen.processing)
    frozen.processing.supplementalEntries = true;
}
/** Preserve actual admission decisions, never inferred empty transcript results. */
export function recordSpeechRejection(
  meeting: MeetingData,
  snippet: Pick<AudioSnippet, "userId" | "timestamp" | "pcmSpans">,
  coverage: SpeechCoverage,
  phase: SpeechPhase,
): void {
  const frozen = snapshots.get(meeting);
  try {
    if (!frozen || !meeting.recordingCapture)
      throw Error("checkpoint_unavailable");
    if (meeting.runtimeConfig?.transcription.speechDetectionMode !== "enforce")
      throw Error("mode_unavailable");
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          frozen.capture.meetingId,
          snippet.userId,
          snippet.timestamp,
          phase,
          coverage.pcmSha256,
          coverage.policyFingerprint,
          snippet.pcmSpans,
        ]),
      )
      .digest("hex");
    if (!frozen.rejections.has(id)) {
      const receipt = speechRejectionSchema.parse({
        id,
        mode: "enforce",
        decision: "non_speech",
        phase,
        decidedAt: new Date().toISOString(),
        userId: snippet.userId,
        snippetTimestamp: snippet.timestamp,
        ...coverage,
        spans: snippet.pcmSpans,
        outcome: "request_skipped",
      });
      frozen.rejections.set(id, receipt);
    }
    checkpointCompletedTranscription(meeting);
  } catch {
    if (frozen) frozen.rejectionEvidenceIncomplete = true;
    console.error("Speech rejection review evidence unavailable.");
    try {
      checkpointCompletedTranscription(meeting);
    } catch {
      /* Recording must continue. */
    }
  }
}

export function checkpointCompletedTranscription(
  meeting: MeetingData,
  processing?: CompletedTranscriptionCheckpoint["processing"],
): void {
  const frozen = snapshots.get(meeting);
  if (!frozen || !frozen.capture.requested.transcribeMeeting) return;

  if (processing && !frozen.processing) {
    frozen.processing = {
      ...processing,
      correspondence: copyCorrespondence(frozen.aggregate?.correspondence),
    };
    frozen.phase = "finalized";
  }
  const completedAt = new Date().toISOString();
  let selected = meeting.audioData.audioFiles.map(selectFile);
  let entries = snapshotEntries(meeting, selected, completedAt);
  let omitted = snapshotOmissions(selected);
  if (!processing && frozen.phase === "finalizing") {
    const guarded = snapshotGuardedTranscription(
      meeting,
      frozen.prePass,
      selected,
      completedAt,
    );
    if (!guarded) return;
    ({ selected, entries, omitted } = guarded);
  }
  markSupplementalTranscriptEntries(frozen, selected);
  if (
    !entries.length &&
    !omitted &&
    !frozen.processing &&
    !frozen.rejections.size &&
    !frozen.rejectionEvidenceIncomplete
  )
    return;
  const speechRejections = Array.from(frozen.rejections.values(), (receipt) => {
    const file = meeting.audioData.audioFiles.find(
      (f) =>
        f.userId === receipt.userId && f.timestamp === receipt.snippetTimestamp,
    );
    const outcome =
      file?.finalSpeechRejection?.pcmSha256 === receipt.pcmSha256
        ? "final_omission"
        : file && resolveAudioFileTranscript(file).text?.trim()
          ? "transcript_present"
          : "request_skipped";
    return { ...receipt, outcome };
  });
  const payload = completedTranscriptionSchema.parse({
    schemaVersion: 1,
    kind: "completed_transcription",
    speechRejections,
    speechRejectionEvidenceIncomplete: frozen.rejectionEvidenceIncomplete,
    processing: frozen.processing,
    capture: frozen.capture,
    capturedAt: completedAt,
    entries,
    omitted,
  });
  checkpointRecordingContext(meeting);
  enqueue(meeting, frozen, "transcription", payload);
}

async function capturePrompts(
  frozen: Frozen,
  names: Array<[keyof Frozen["prompts"], string, "text" | "chat"]>,
  label: string,
) {
  await Promise.all(
    names.map(async ([role, name, type]) => {
      try {
        frozen.prompts[role] = {
          availability: "available",
          value: await snapshotRecordingPrompt(name, type, label),
        };
      } catch {
        frozen.prompts[role] = { availability: "unavailable" };
      }
    }),
  );
}
async function captureContext(
  meeting: MeetingData,
  frozen: Frozen,
  effective: SavedRecordingSettings,
  signal: AbortSignal,
) {
  const result = await collectMeetingContext(
    meeting,
    effective.notes.enableMemory,
    { signal, strict: true, memoryDepth: effective.notes.memoryDepth },
  );
  const data = result.data;
  frozen.context = {
    availability: result.availability,
    meetingContext: data.meetingContext,
    serverContext: data.serverContext,
    channelContext: data.channelContext,
    recentMeetings: (data.recentMeetings ?? []).map((row) => ({
      timestamp: row.timestamp,
      context: row.context,
      notes: row.notes,
    })),
    dictionaryEntries: (data.dictionaryEntries ?? []).map((item) => ({
      term: item.term,
      definition: item.definition,
      updatedAt: item.updatedAt,
    })),
    transcriptionFormattedContext: formatContextForPrompt(
      data,
      "transcription",
      effective.notes.maxContextLength,
    ),
    transcriptionMaxContextLength: effective.notes.maxContextLength,
    formattedContext: formatContextForPrompt(
      data,
      "notes",
      effective.notes.maxContextLength,
    ),
  };
  if (frozen.capture.requested.generateNotes) {
    try {
      frozen.recentMeetingNames = {
        availability: "available",
        value: isFixture(meeting)
          ? ""
          : await listRecentMeetingNamesForPrompt({
              guildId: meeting.guildId,
              excludeMeetingId: meeting.meetingId,
              signal,
            }),
      };
    } catch {
      frozen.recentMeetingNames = { availability: "unavailable" };
    }
  }
}
/** The actual bounded lookup promise is exposed to R3; capture never awaits it. */
function initialContextValue(meeting: MeetingData) {
  return isFixture(meeting) ? undefined : meeting.meetingContext;
}
export function startRecordingContentCheckpoint(meeting: MeetingData): void {
  if (
    snapshots.has(meeting) ||
    !meeting.recordingCapture ||
    !meeting.ownershipSignal
  )
    return;
  const frozen: Frozen = {
    capture: provenance(meeting),
    rejections: new Map(),
    rejectionEvidenceIncomplete: false,
    sequence: 0,
    phase: "capturing",
    settings: { availability: "unavailable" },
    prompts: {},
    recentMeetingNames: { availability: "unavailable" },
    context: {
      availability: "unavailable",
      meetingContext: initialContextValue(meeting),
      recentMeetings: [],
      dictionaryEntries: [],
      formattedContext: "",
    },
  };
  snapshots.set(meeting, frozen);
  const names: Array<[keyof Frozen["prompts"], string, "text" | "chat"]> = [];
  let effective: SavedRecordingSettings;
  try {
    effective = settings(meeting);
    frozen.settings = { availability: "available", value: effective };
  } catch {
    checkpointRecordingContext(meeting);
    return;
  }
  if (frozen.capture.requested.transcribeMeeting) {
    names.push([
      "transcription",
      config.langfuse.transcriptionPromptName,
      "text",
    ]);
    if (effective.premiumTranscription.cleanupEnabled)
      names.push([
        "cleanup",
        config.langfuse.transcriptionCleanupPromptName,
        "chat",
      ]);
    if (effective.premiumTranscription.enabled)
      names.push([
        "coalesce",
        config.langfuse.transcriptionCoalescePromptName,
        "chat",
      ]);
    if (effective.transcription.finalPassEnabled)
      names.push([
        "finalPass",
        config.langfuse.transcriptionFinalPassPromptName,
        "chat",
      ]);
    if (frozen.capture.requested.generateNotes) {
      names.push(
        [
          "notes",
          effective.notes.longStoryTestMode
            ? config.langfuse.notesLongStoryPromptName
            : effective.notes.contextTestMode
              ? config.langfuse.notesContextTestPromptName
              : config.langfuse.notesPromptName,
          "chat",
        ],
        ["summary", config.langfuse.meetingSummaryPromptName, "chat"],
      );
    }
  }
  for (const [role] of names)
    frozen.prompts[role] = { availability: "unavailable" };
  checkpointRecordingContext(meeting);
  const signal = AbortSignal.any([
    meeting.ownershipSignal,
    AbortSignal.timeout(5000),
  ]);
  meeting.recordingContentTask = Promise.allSettled([
    captureContext(meeting, frozen, effective, signal),
    capturePrompts(frozen, names, config.langfuse.promptLabel),
  ])
    .then(() => {
      if (!meeting.ownershipSignal?.aborted)
        checkpointRecordingContext(meeting);
    })
    .catch(() => {
      /* Initial explicit unavailable snapshot remains canonical. */
    });
}
