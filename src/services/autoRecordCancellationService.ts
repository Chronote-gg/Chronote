import { resolveAudioFileText } from "../utils/audioTranscript";
import {
  completionSnapshot,
  freezeCompletionPolicy,
} from "./meetingCompletionPolicyService";
import { waitForFinishProcessing } from "../audio";
import type { MeetingData } from "../types/meeting-data";
import type { MeetingRuntimeConfig } from "../config/types";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import {
  EmptyOpenAITextOutputError,
  generateOpenAIText,
} from "./openaiTextService";
import { buildModelOverrides, getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { assertMeetingProcessingSucceeded } from "../utils/meetingProcessing";
import { countWords } from "../utils/text";

type CancellationDecision = {
  cancel: boolean;
  reason?: string;
};

const MAX_TRANSCRIPT_CHARS = 1200;
const MAX_CHAT_LINES = 3;

const collectTranscriptText = (meeting: MeetingData) =>
  meeting.audioData.audioFiles
    .map((file) => resolveAudioFileText(file))
    .filter((text): text is string => Boolean(text && text.trim()))
    .join(" ");

const collectChatLines = (meeting: MeetingData) =>
  meeting.chatLog
    .filter((entry) => entry.type === "message")
    .slice(0, MAX_CHAT_LINES)
    .map((entry) => {
      const content = entry.content?.trim();
      const attachments = entry.attachments ?? [];
      if (attachments.length === 0) {
        return content;
      }
      const shown = attachments.map((a) => a.name).slice(0, 3);
      const extra = attachments.length - shown.length;
      const suffix = extra > 0 ? ` +${extra} more` : "";
      const attachmentLabel = `attachments: ${shown.join(", ")}${suffix}`;
      if (content) {
        return `${content} (${attachmentLabel})`;
      }
      return `[${attachmentLabel}]`;
    })
    .filter((line): line is string => Boolean(line && line.trim()));

function parseCancellationDecision(content: string): CancellationDecision {
  const parsed = JSON.parse(content) as {
    cancel?: boolean;
    reason?: string;
  };
  const cancel = Boolean(parsed.cancel);
  const reason = parsed.reason?.trim();
  if (!cancel) return { cancel: false };
  return {
    cancel: true,
    reason:
      reason && reason.length > 0 ? reason : "Not enough content detected.",
  };
}

export type AutoRecordCancellationFacts = {
  policy: CompletionPolicy["policy"];
  durationSeconds: number;
  chatMessageCount: number;
  /** Read only once the duration and chat bounds pass, since reading can wait on transcription. */
  content: () => Promise<{ transcriptText: string; chatLines: string[] }>;
  /** Absent means the role defaults. */
  runtimeConfig?: Pick<MeetingRuntimeConfig, "modelChoices" | "modelParams">;
  meetingId: string;
  guildId: string;
  channelId: string;
  /** Aborts the model call; absent on the live path. */
  signal?: AbortSignal;
};

export async function evaluateAutoRecordCancellation(
  meeting: MeetingData,
): Promise<CancellationDecision> {
  if (!meeting.isAutoRecording) return { cancel: false };
  const snapshot = completionSnapshot(meeting);
  const policy = snapshot?.policy ?? freezeCompletionPolicy(meeting);
  if (!policy.enabled) return { cancel: false };
  if (meeting.reservation && snapshot?.elapsedMilliseconds === undefined)
    throw new Error("Original auto-record duration is unavailable");

  const durationSeconds =
    snapshot?.elapsedMilliseconds !== undefined
      ? Math.floor(snapshot.elapsedMilliseconds / 1000)
      : meeting.endTime
        ? Math.max(
            0,
            Math.floor(
              (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000,
            ),
          )
        : 0;
  return decideAutoRecordCancellation({
    policy,
    durationSeconds,
    chatMessageCount: meeting.chatLog.filter(
      (entry) => entry.type === "message",
    ).length,
    content: async () => {
      await waitForFinishProcessing(meeting);
      assertMeetingProcessingSucceeded(meeting);
      return {
        transcriptText: collectTranscriptText(meeting),
        chatLines: collectChatLines(meeting),
      };
    },
    runtimeConfig: meeting.runtimeConfig,
    meetingId: meeting.meetingId,
    guildId: meeting.guild.id,
    channelId: meeting.voiceChannel.id,
  });
}

/** The cancellation decision over plain facts, shared by the live meeting and recovery. */
export async function decideAutoRecordCancellation(
  facts: AutoRecordCancellationFacts,
): Promise<CancellationDecision> {
  const { policy, durationSeconds, chatMessageCount } = facts;
  if (!policy.enabled) return { cancel: false };
  if (
    durationSeconds > policy.maximumSeconds ||
    chatMessageCount > policy.maximumChatMessages
  ) {
    return { cancel: false };
  }

  const read = await facts.content();
  const transcriptText = read.transcriptText;
  const chatLines = read.chatLines.slice(0, MAX_CHAT_LINES);
  const transcriptWords = countWords(transcriptText);

  const isHeuristicMatch =
    durationSeconds <= policy.maximumSeconds &&
    transcriptWords <= policy.maximumWords &&
    chatMessageCount <= policy.maximumChatMessages;

  if (!isHeuristicMatch) {
    return { cancel: false };
  }

  const transcriptSample = transcriptText.slice(0, MAX_TRANSCRIPT_CHARS);
  const chatSample =
    chatLines.length > 0 ? chatLines.join("\n") : "No chat messages.";

  const systemPrompt =
    "You review auto-recorded Discord meetings and decide whether they were accidental. " +
    'Return EXACTLY one JSON object: {"cancel": true|false, "reason": "short sentence"} ' +
    "The reason should be short and mention why the meeting should be cancelled. " +
    "If there is meaningful content, return cancel=false. " +
    "Never include markdown, extra keys, or extra text.";

  const userPrompt = [
    `Duration seconds: ${durationSeconds}`,
    `Transcript word count: ${transcriptWords}`,
    `Transcript sample: ${transcriptSample || "No transcript."}`,
    `Chat messages: ${chatMessageCount}`,
    `Chat sample: ${chatSample}`,
    "Question: Should this meeting be cancelled as an accidental auto-recording?",
  ].join("\n");

  try {
    const modelChoice = getModelChoice(
      "autoRecordCancel",
      buildModelOverrides(facts.runtimeConfig?.modelChoices),
    );
    const modelParams = resolveChatParamsForRole({
      role: "autoRecordCancel",
      model: modelChoice.model,
      config: facts.runtimeConfig?.modelParams?.autoRecordCancel,
    });
    const content = await generateOpenAIText({
      model: modelChoice.model,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      modelParams,
      maxOutputTokens: 120,
      ...(facts.signal ? { signal: facts.signal } : {}),
      format: { kind: "json_object" },
      tracing: {
        traceName: "auto-record-cancel",
        generationName: "auto-record-cancel",
        sessionId: facts.meetingId,
        tags: ["feature:auto_record_cancel"],
        metadata: {
          guildId: facts.guildId,
          channelId: facts.channelId,
        },
      },
    });
    return parseCancellationDecision(content);
  } catch (error) {
    if (error instanceof EmptyOpenAITextOutputError) return { cancel: false };
    console.error("Auto-record cancellation check failed:", error);
    throw error;
  }
}
