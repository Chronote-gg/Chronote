import type OpenAI from "openai";
import type { SpanContext } from "@opentelemetry/api";
import type { MeetingData } from "../types/meeting-data";
import { createOpenAIClient } from "./openaiClient";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import type { ModelParamRole } from "../config/types";
import type { LangfusePromptMeta } from "./langfusePromptService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";

type ChatInput = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "model" | "user" | "temperature" | "reasoning_effort" | "verbosity"
>;

type ChatOptions = {
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
    const response = await input.openAIClient.chat.completions.create({
      model: input.model,
      user: input.userId,
      ...input.body,
      ...input.modelParams,
    });
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

export async function chat(
  meeting: MeetingData,
  body: ChatInput,
  options: ChatOptions = {},
): Promise<string> {
  const traceName = options.traceName ?? "notes";
  const model =
    options.model ??
    getModelChoice("notes", getMeetingModelOverrides(meeting)).model;
  const modelParamRole = options.modelParamRole ?? "notes";
  const modelParams = resolveChatParamsForRole({
    role: modelParamRole,
    model,
    config: meeting.runtimeConfig?.modelParams?.[modelParamRole],
  });
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
