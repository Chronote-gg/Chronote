import { waitForFinishProcessing } from "../audio";
import type { MeetingData } from "../types/meeting-data";
import { createOpenAIClient } from "./openaiClient";
import { buildModelOverrides, getModelChoice } from "./modelFactory";
import { config } from "./configService";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { countWords } from "../utils/text";

type CancellationDecision = {
  cancel: boolean;
  reason?: string;
};

const MAX_DURATION_SECONDS = 90;
const MAX_TRANSCRIPT_WORDS = 50;
const MAX_CHAT_MESSAGES = 1;
const MAX_TRANSCRIPT_CHARS = 1200;
const MAX_CHAT_LINES = 3;

const isAutoCancelEnabled = (meeting: MeetingData) => {
  if (config.mock.enabled) return false;
  if (meeting.runtimeConfig?.autoRecordCancellation?.enabled === false) {
    return false;
  }
  return true;
};

const collectTranscriptText = (meeting: MeetingData) =>
  meeting.audioData.audioFiles
    .map((file) => file.transcript)
    .filter((text): text is string => Boolean(text && text.trim()))
    .join(" ");

const collectChatLines = (meeting: MeetingData) =>
  meeting.chatLog
    .filter((entry) => entry.type === "message")
    .slice(0, MAX_CHAT_LINES)
    .map((entry) => entry.content)
    .filter((content): content is string => Boolean(content && content.trim()));

export async function evaluateAutoRecordCancellation(
  meeting: MeetingData,
): Promise<CancellationDecision> {
  if (!meeting.isAutoRecording) return { cancel: false };
  if (!isAutoCancelEnabled(meeting)) return { cancel: false };

  const durationSeconds = meeting.endTime
    ? Math.max(
        0,
        Math.floor(
          (meeting.endTime.getTime() - meeting.startTime.getTime()) / 1000,
        ),
      )
    : 0;
  const chatMessageCount = meeting.chatLog.filter(
    (entry) => entry.type === "message",
  ).length;

  if (
    durationSeconds > MAX_DURATION_SECONDS ||
    chatMessageCount > MAX_CHAT_MESSAGES
  ) {
    return { cancel: false };
  }

  await waitForFinishProcessing(meeting);
  const transcriptText = collectTranscriptText(meeting);
  const transcriptWords = countWords(transcriptText);
  const chatLines = collectChatLines(meeting);

  const isHeuristicMatch =
    durationSeconds <= MAX_DURATION_SECONDS &&
    transcriptWords <= MAX_TRANSCRIPT_WORDS &&
    chatMessageCount <= MAX_CHAT_MESSAGES;

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
      buildModelOverrides(meeting.runtimeConfig?.modelChoices),
    );
    const modelParams = resolveChatParamsForRole({
      role: "autoRecordCancel",
      model: modelChoice.model,
      config: meeting.runtimeConfig?.modelParams?.autoRecordCancel,
    });
    const openAIClient = createOpenAIClient({
      traceName: "auto-record-cancel",
      generationName: "auto-record-cancel",
      sessionId: meeting.meetingId,
      tags: ["feature:auto_record_cancel"],
      metadata: {
        guildId: meeting.guild.id,
        channelId: meeting.voiceChannel.id,
      },
    });
    const completion = await openAIClient.chat.completions.create({
      model: modelChoice.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 120,
      response_format: { type: "json_object" },
      ...modelParams,
    });

    const content = completion.choices[0].message.content ?? "";
    if (!content.trim()) {
      return { cancel: false };
    }
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
  } catch (error) {
    console.error("Auto-record cancellation check failed:", error);
    return { cancel: false };
  }
}
