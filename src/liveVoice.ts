import { MeetingData } from "./types/meeting-data";
import { config } from "./services/configService";
import { createOpenAIClient } from "./services/openaiClient";
import { buildModelOverrides, getModelChoice } from "./services/modelFactory";
import { resolveChatParamsForRole } from "./services/openaiModelParams";
import { getLangfuseChatPrompt } from "./services/langfusePromptService";
import {
  buildLiveResponderContext,
  LatestUtterance,
} from "./services/liveResponderContextService";
import { formatParticipantLabel } from "./utils/participants";
import { getBotNameVariants } from "./utils/botNames";
import { resolveTtsVoice } from "./utils/ttsVoices";
import { formatLongDate, toIsoString } from "./utils/time";
import {
  enqueueDenialCue,
  startThinkingCueLoop,
  stopThinkingCueLoop,
} from "./audio/soundCues";
import { canUserEndMeeting } from "./utils/meetingPermissions";
import { MEETING_END_REASONS } from "./types/meetingLifecycle";

type GateAction = "respond" | "command_end" | "none";

type GateDecision = {
  action: GateAction;
};

type ConfirmationDecision = {
  decision: "confirm" | "deny" | "unclear";
};

type LiveVoiceFlags = {
  liveVoiceEnabled: boolean;
  liveVoiceCommandsEnabled: boolean;
};

export type LiveSegment = {
  userId: string;
  text: string;
  timestamp: number;
};

const RECENT_LINES = 3;
const COMMAND_CONFIRM_TIMEOUT_MS = 30_000;
const COMMAND_CONFIRM_PROMPT = "Chronote: Confirm end meeting?";
const COMMAND_DENY_PROMPT = "Chronote: Okay, confirmed your denial.";

function getSpeakerLabel(meeting: MeetingData, userId: string): string {
  const participant = meeting.participants.get(userId);
  return formatParticipantLabel(participant, {
    includeUsername: false,
    fallbackName: userId,
  });
}

function collectRecentTranscripts(meeting: MeetingData): string[] {
  const lines = meeting.audioData.audioFiles
    .filter((f) => f.transcript && f.transcript.length > 0)
    .slice(-RECENT_LINES)
    .map((f) => {
      const speaker = getSpeakerLabel(meeting, f.userId);
      return `${speaker}: ${f.transcript}`;
    });
  return lines;
}

function isAddressed(text: string, meeting: MeetingData): boolean {
  const lower = text.toLowerCase();
  const botNames = getBotNameVariants(
    meeting.guild.members.me,
    meeting.guild.client.user,
  ).map((name) => name.toLowerCase());
  return botNames.some((name) => name && lower.includes(name));
}

async function shouldAct(
  meeting: MeetingData,
  segment: LiveSegment,
): Promise<GateDecision> {
  const recent = collectRecentTranscripts(meeting);
  const speaker = getSpeakerLabel(meeting, segment.userId);

  console.log(
    `[live-voice][gate] candidate text="${segment.text.slice(0, 120)}"${
      segment.text.length > 120 ? "..." : ""
    } speaker=${speaker}`,
  );
  const latestLine = `Latest line (${toIsoString(segment.timestamp)}): ${speaker}: ${segment.text}`;
  const recentContext =
    recent.length > 0
      ? `Recent context:\n${recent.join("\n")}`
      : "No prior transcript context.";
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.liveVoiceGatePromptName,
    variables: {
      latestLine,
      recentContext,
      serverName: meeting.guild.name,
      channelName: meeting.voiceChannel.name,
    },
  });

  try {
    const modelChoice = getModelChoice(
      "liveVoiceGate",
      buildModelOverrides(meeting.runtimeConfig?.modelChoices),
    );
    const modelParams = resolveChatParamsForRole({
      role: "liveVoiceGate",
      model: modelChoice.model,
      config: meeting.runtimeConfig?.modelParams?.liveVoiceGate,
    });
    const openAIClient = createOpenAIClient({
      traceName: "live-voice-gate",
      generationName: "live-voice-gate",
      userId: segment.userId,
      sessionId: meeting.meetingId,
      tags: ["feature:live_voice_gate"],
      metadata: {
        guildId: meeting.guild.id,
        channelId: meeting.voiceChannel.id,
      },
      langfusePrompt,
    });
    const completion = await openAIClient.chat.completions.create({
      model: modelChoice.model,
      messages,
      max_completion_tokens: config.liveVoice.gateMaxOutputTokens,
      response_format: { type: "json_object" },
      ...modelParams,
    });

    const content = completion.choices[0].message.content ?? "";
    const finish = completion.choices[0].finish_reason;
    console.log(
      `[live-voice][gate] model=${modelChoice.model} finish=${finish} raw=${content}`,
    );

    if (!content.trim()) {
      console.warn("[live-voice][gate] empty content from gate model");
      return { action: "none" };
    }

    const parsed = JSON.parse(content) as GateDecision;
    if (
      parsed.action !== "respond" &&
      parsed.action !== "command_end" &&
      parsed.action !== "none"
    ) {
      return { action: "none" };
    }
    return { action: parsed.action };
  } catch (error) {
    console.error("Live voice gate failed:", error);
    return { action: "none" };
  }
}

async function generateReply(
  meeting: MeetingData,
  segment: LiveSegment,
): Promise<string | undefined> {
  const speaker = getSpeakerLabel(meeting, segment.userId);
  const latest: LatestUtterance = {
    speaker,
    text: segment.text,
    timestamp: segment.timestamp,
  };

  const { variables, debug } = await buildLiveResponderContext(meeting, latest);

  const todayLabel = formatLongDate(new Date());
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.liveVoiceResponderPromptName,
    variables: {
      todayLabel,
      ...variables,
    },
  });

  try {
    const modelChoice = getModelChoice(
      "liveVoiceResponder",
      buildModelOverrides(meeting.runtimeConfig?.modelChoices),
    );
    const modelParams = resolveChatParamsForRole({
      role: "liveVoiceResponder",
      model: modelChoice.model,
      config: meeting.runtimeConfig?.modelParams?.liveVoiceResponder,
    });
    const openAIClient = createOpenAIClient({
      traceName: "live-voice-responder",
      generationName: "live-voice-responder",
      userId: segment.userId,
      sessionId: meeting.meetingId,
      tags: ["feature:live_voice_responder"],
      metadata: {
        guildId: meeting.guild.id,
        channelId: meeting.voiceChannel.id,
      },
      langfusePrompt,
    });
    const completion = await openAIClient.chat.completions.create({
      model: modelChoice.model,
      messages,
      max_completion_tokens: 200,
      ...modelParams,
    });

    const content = completion.choices[0].message.content ?? "";
    console.log(
      `[live-voice][responder] model=${modelChoice.model} ` +
        `windowLines=${debug.windowLines} pastMeetings=${
          debug.pastMeetings.map((m) => m.meetingId).join(",") || "none"
        }`,
    );
    if (!content.trim()) return undefined;
    return content.trim();
  } catch (error) {
    console.error("Live voice responder failed:", error);
    return undefined;
  }
}

function resolveBotUserId(meeting: MeetingData): string | undefined {
  return meeting.guild.members.me?.user.id || meeting.creator.client.user?.id;
}

function enqueueLiveVoice(
  meeting: MeetingData,
  text: string,
  priority: "high" | "normal" = "normal",
  onBeforePlay?: (meeting: MeetingData) => void,
): boolean {
  const botUserId = resolveBotUserId(meeting);
  if (!botUserId) {
    console.warn("Could not determine bot user id for live voice reply.");
    return false;
  }
  if (!meeting.ttsQueue) {
    console.warn("Live voice reply dropped because TTS queue is unavailable.");
    return false;
  }
  const voice = resolveTtsVoice(
    meeting.liveVoiceTtsVoice,
    config.liveVoice.ttsVoice,
  );
  const enqueued = meeting.ttsQueue.enqueue({
    text,
    voice,
    userId: botUserId,
    source: "live_voice",
    priority,
    onBeforePlay,
  });
  if (!enqueued) {
    console.warn("Live voice reply dropped because TTS queue is full.");
  }
  return enqueued;
}

function getActivePendingCommand(meeting: MeetingData) {
  const pending = meeting.liveVoiceCommandPending;
  if (!pending) return undefined;
  if (pending.expiresAt <= Date.now()) {
    meeting.liveVoiceCommandPending = undefined;
    return undefined;
  }
  return pending;
}

async function classifyConfirmation(
  meeting: MeetingData,
  segment: LiveSegment,
): Promise<ConfirmationDecision> {
  const speaker = getSpeakerLabel(meeting, segment.userId);
  const responseLine = `Response (${toIsoString(segment.timestamp)}): ${speaker}: ${segment.text}`;
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.liveVoiceConfirmPromptName,
    variables: {
      responseLine,
    },
  });

  try {
    const modelChoice = getModelChoice(
      "liveVoiceGate",
      buildModelOverrides(meeting.runtimeConfig?.modelChoices),
    );
    const modelParams = resolveChatParamsForRole({
      role: "liveVoiceGate",
      model: modelChoice.model,
      config: meeting.runtimeConfig?.modelParams?.liveVoiceGate,
    });
    const openAIClient = createOpenAIClient({
      traceName: "live-voice-confirm",
      generationName: "live-voice-confirm",
      userId: segment.userId,
      sessionId: meeting.meetingId,
      tags: ["feature:live_voice_confirm"],
      metadata: {
        guildId: meeting.guild.id,
        channelId: meeting.voiceChannel.id,
      },
      langfusePrompt,
    });
    const completion = await openAIClient.chat.completions.create({
      model: modelChoice.model,
      messages,
      max_completion_tokens: config.liveVoice.gateMaxOutputTokens,
      response_format: { type: "json_object" },
      ...modelParams,
    });

    const content = completion.choices[0].message.content ?? "";
    const finish = completion.choices[0].finish_reason;
    console.log(
      `[live-voice][confirm] model=${modelChoice.model} finish=${finish} raw=${content}`,
    );

    if (!content.trim()) {
      console.warn("[live-voice][confirm] empty content from gate model");
      return { decision: "unclear" };
    }

    const parsed = JSON.parse(content) as ConfirmationDecision;
    if (
      parsed.decision !== "confirm" &&
      parsed.decision !== "deny" &&
      parsed.decision !== "unclear"
    ) {
      return { decision: "unclear" };
    }
    return parsed;
  } catch (error) {
    console.error("Live voice confirmation failed:", error);
    return { decision: "unclear" };
  }
}

function startCommandConfirmation(meeting: MeetingData, segment: LiveSegment) {
  if (meeting.liveVoiceCommandPending) {
    return;
  }
  if (!canUserEndMeeting(meeting, segment.userId)) {
    console.warn(
      `[live-voice][confirm] user ${segment.userId} lacks permission to end meeting.`,
    );
    return;
  }
  const now = Date.now();
  meeting.liveVoiceCommandPending = {
    type: "end_meeting",
    userId: segment.userId,
    requestedAt: now,
    expiresAt: now + COMMAND_CONFIRM_TIMEOUT_MS,
  };
  const enqueued = enqueueLiveVoice(meeting, COMMAND_CONFIRM_PROMPT, "high");
  if (!enqueued) {
    meeting.liveVoiceCommandPending = undefined;
    console.error(
      "[live-voice][confirm] Failed to enqueue end-meeting confirmation prompt. Dropping pending command.",
    );
  }
}

function resolveLiveVoiceFlags(meeting: MeetingData): LiveVoiceFlags {
  return {
    liveVoiceEnabled: Boolean(meeting.liveVoiceEnabled),
    liveVoiceCommandsEnabled: Boolean(meeting.liveVoiceCommandsEnabled),
  };
}

function isLiveVoiceActive(flags: LiveVoiceFlags): boolean {
  return flags.liveVoiceEnabled || flags.liveVoiceCommandsEnabled;
}

async function handlePendingCommandIfAny(
  meeting: MeetingData,
  segment: LiveSegment,
): Promise<boolean> {
  const pending = getActivePendingCommand(meeting);
  if (!pending) return false;
  if (segment.userId !== pending.userId) return true;

  const confirmation = await classifyConfirmation(meeting, segment);
  if (confirmation.decision === "confirm") {
    meeting.liveVoiceCommandPending = undefined;
    if (meeting.finishing || meeting.finished) return true;
    if (!canUserEndMeeting(meeting, segment.userId)) {
      console.warn(
        `[live-voice][confirm] user ${segment.userId} lacks permission to end meeting.`,
      );
      return true;
    }
    meeting.endReason = MEETING_END_REASONS.LIVE_VOICE;
    meeting.endTriggeredByUserId = segment.userId;
    if (meeting.onEndMeeting) {
      await meeting.onEndMeeting(meeting);
    } else {
      console.warn("Live voice confirm had no end meeting handler.");
    }
    return true;
  }
  if (confirmation.decision === "deny") {
    meeting.liveVoiceCommandPending = undefined;
    const botUserId = resolveBotUserId(meeting);
    const cueEnqueued = botUserId
      ? enqueueDenialCue(meeting, botUserId)
      : false;
    if (!cueEnqueued) {
      enqueueLiveVoice(meeting, COMMAND_DENY_PROMPT, "high");
    }
  }
  return true;
}

async function handleGateDecision(
  meeting: MeetingData,
  segment: LiveSegment,
  decision: GateDecision,
  flags: LiveVoiceFlags,
): Promise<void> {
  if (decision.action === "command_end") {
    if (!flags.liveVoiceCommandsEnabled) return;
    startCommandConfirmation(meeting, segment);
    return;
  }
  if (decision.action !== "respond") return;
  if (!flags.liveVoiceEnabled) return;

  const botUserId = resolveBotUserId(meeting);
  if (botUserId) {
    startThinkingCueLoop(meeting, botUserId);
  }

  let reply: string | undefined;
  try {
    reply = await generateReply(meeting, segment);
  } finally {
    if (!reply && botUserId) {
      stopThinkingCueLoop(meeting);
    }
  }
  if (!reply) return;

  console.log(
    `[live-voice][speak] replying="${reply.slice(0, 120)}"${
      reply.length > 120 ? "..." : ""
    }`,
  );
  const enqueued = enqueueLiveVoice(
    meeting,
    reply,
    "high",
    botUserId ? stopThinkingCueLoop : undefined,
  );
  if (!enqueued && botUserId) {
    stopThinkingCueLoop(meeting);
  }
}

export async function maybeRespondLive(
  meeting: MeetingData,
  segment: LiveSegment,
): Promise<void> {
  if (!segment.text.trim()) return;

  const flags = resolveLiveVoiceFlags(meeting);
  if (!isLiveVoiceActive(flags)) return;

  const handledPending = await handlePendingCommandIfAny(meeting, segment);
  if (handledPending) return;

  if (!isAddressed(segment.text, meeting)) return;

  const decision = await shouldAct(meeting, segment);
  await handleGateDecision(meeting, segment, decision, flags);
}
