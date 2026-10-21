import { fixtureGenerationObserver } from "./fixtureInputService";
import { getMeetingProcessingSignal } from "./meetingProcessingLifetime";
import type OpenAI from "openai";
import type { SpanContext } from "@opentelemetry/api";
import type { MeetingData, MeetingNotesInput } from "../types/meeting-data";
import {
  buildOpenAISafetyIdentifier,
  createOpenAIClient,
} from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import type { ModelParamRole } from "../config/types";
import type { LangfusePromptMeta } from "./langfusePromptService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";

type ChatInput = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  | "model"
  | "user"
  | "safety_identifier"
  | "temperature"
  | "reasoning_effort"
  | "verbosity"
>;

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

type ChatLoopInput = {
  observeGeneration?: import("../types/fixtureEvidence").GenerationObserver;
  langfusePrompt?: LangfusePromptMeta;
  signal?: AbortSignal;
  openAIClient: ReturnType<typeof createOpenAIClient>;
  body: ChatInput;
  model: string;
  modelParams: ReturnType<typeof resolveChatParamsForRole>;
  traceName: string;
  userId: string;
};

type ChatLoopResult = {
  output: string;
  count: number;
  truncated: boolean;
};

const logFinishReason = (
  traceName: string,
  model: string,
  finishReason: string,
) => {
  console.log(
    `Chat completion finish reason: ${finishReason} (trace=${traceName} model=${model})`,
  );
};

const logEmptyContent = (traceName: string, model: string) => {
  console.warn(
    `Chat completion returned empty content (trace=${traceName} model=${model}).`,
  );
};

const logChatSummary = (
  traceName: string,
  model: string,
  count: number,
  truncated: boolean,
) => {
  const detail = truncated ? "due to length" : "without continuation";
  console.log(
    `Chat completed in ${count} call(s) ${detail} (trace=${traceName} model=${model}).`,
  );
};

const runChatLoop = async (input: ChatLoopInput): Promise<ChatLoopResult> => {
  let output = "";
  let count = 0;
  let truncated = false;

  for (;;) {
    input.signal?.throwIfAborted();
    const acknowledge = input.observeGeneration?.(
      input.traceName,
      input.model,
      input.langfusePrompt,
    );
    const response = await input.openAIClient.chat.completions.create(
      {
        model: input.model,
        safety_identifier: buildOpenAISafetyIdentifier(input.userId),
        ...input.body,
        ...input.modelParams,
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    input.signal?.throwIfAborted();
    acknowledge?.(response.model ?? null);
    const choice = response.choices[0];
    logFinishReason(input.traceName, input.model, choice.finish_reason);
    count += 1;

    const responseValue = choice.message.content ?? "";
    if (!responseValue) {
      logEmptyContent(input.traceName, input.model);
      return { output, count, truncated };
    }

    output += responseValue;
    input.body.messages.push({
      role: "assistant",
      content: responseValue,
    });

    if (choice.finish_reason !== "length") {
      return { output, count, truncated };
    }
    truncated = true;
  }
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
  return { model, modelParams };
}
export async function chat(
  meeting: ChatMeetingInput,
  body: ChatInput,
  options: ChatOptions = {},
): Promise<string> {
  const traceName = options.traceName ?? "notes";
  const { model, modelParams } = resolveMeetingChatModel(meeting, options);
  const openAIClient = createOpenAIClient({
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
  });
  const { output, count, truncated } = await runChatLoop({
    observeGeneration:
      meeting.observeGeneration ?? fixtureGenerationObserver(meeting),
    langfusePrompt: options.langfusePrompt,
    signal: AbortSignal.any([
      meeting.signal ?? getMeetingProcessingSignal(meeting),
      ...(options.signal ? [options.signal] : []),
    ]),
    openAIClient,
    body,
    model,
    modelParams,
    traceName,
    userId: meeting.creator.id,
  });
  logChatSummary(traceName, model, count, truncated);
  return output;
}
