import { fixtureGenerationObserver } from "./fixtureInputService";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";
import type { SpanContext } from "@opentelemetry/api";
import type { MeetingData, MeetingNotesInput } from "../types/meeting-data";
import { buildOpenAISafetyIdentifier } from "./openaiClient";
import {
  generateOpenAIText,
  MEETING_TEXT_MAX_REQUESTS,
} from "./openaiTextService";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import type { ModelParamRole } from "../config/types";
import type { ChatMessage, LangfusePromptMeta } from "./langfusePromptService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";

type ChatInput = { messages: ChatMessage[] };

type ChatOptions = {
  frozenModel?: import("../types/recordingContent").SavedRecordingSettings["models"]["notes"];
  signal?: AbortSignal;
  model?: string;
  traceName?: string;
  generationName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  langfusePrompt?: LangfusePromptMeta;
  parentSpanContext?: SpanContext;
  modelParamRole?: ModelParamRole;
};

export type ChatMeetingInput = Pick<
  MeetingData,
  "meetingId" | "ownershipSignal" | "finalization" | "reservation"
> &
  Pick<MeetingNotesInput, "runtimeConfig"> & {
    observeGeneration?: import("../types/fixtureEvidence").GenerationObserver;
    creator: { id: string };
    guild: { id: string };
    voiceChannel: { id: string };
    signal?: AbortSignal;
    frozenModels?: MeetingNotesInput["frozenModels"];
  };
function resolveMeetingChatModel(
  meeting: ChatMeetingInput,
  options: ChatOptions,
) {
  const model =
    options.frozenModel?.model ??
    meeting.frozenModels?.notes.model ??
    options.model ??
    getModelChoice("notes", getMeetingModelOverrides(meeting)).model;
  const modelParamRole = options.modelParamRole ?? "notes";
  const modelParams =
    options.frozenModel?.params ??
    meeting.frozenModels?.notes.params ??
    resolveChatParamsForRole({
      role: modelParamRole,
      model,
      config: meeting.runtimeConfig?.modelParams?.[modelParamRole],
    });
  return { model, modelParams, modelParamRole };
}
export async function chat(
  meeting: ChatMeetingInput,
  body: ChatInput,
  options: ChatOptions = {},
): Promise<string> {
  const traceName = options.traceName ?? "notes";
  const { model, modelParams, modelParamRole } = resolveMeetingChatModel(
    meeting,
    options,
  );
  return generateOpenAIText({
    observeGeneration:
      meeting.observeGeneration ?? fixtureGenerationObserver(meeting),
    generationOperation: traceName,
    model,
    input: body.messages,
    modelParams,
    modelParamRole,
    continuation: { maxRequests: MEETING_TEXT_MAX_REQUESTS },
    signal: AbortSignal.any([
      meeting.signal ?? getMeetingProcessingSignal(meeting),
      ...(options.signal ? [options.signal] : []),
    ]),
    safetyIdentifier: buildOpenAISafetyIdentifier(meeting.creator.id),
    tracing: {
      traceName,
      generationName: options.generationName ?? traceName,
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: options.tags ?? ["feature:notes"],
      metadata: {
        guildId: meeting.guild.id,
        channelId: meeting.voiceChannel.id,
        ...options.metadata,
      },
      langfusePrompt: options.langfusePrompt,
      parentSpanContext: options.parentSpanContext,
    },
  });
}
