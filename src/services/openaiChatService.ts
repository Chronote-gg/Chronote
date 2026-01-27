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

export async function chat(
  meeting: MeetingData,
  body: ChatInput,
  options: ChatOptions = {},
): Promise<string> {
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
    traceName: options.traceName ?? "notes",
    generationName: options.generationName ?? "notes",
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
  let output = "";
  let done = false;
  let count = 0;
  while (!done) {
    const response = await openAIClient.chat.completions.create({
      model,
      user: meeting.creator.id,
      ...body,
      ...modelParams,
    });
    console.log(
      `Chat completion finish reason: ${response.choices[0].finish_reason} (trace=${options.traceName ?? "notes"} model=${model})`,
    );
    if (response.choices[0].finish_reason !== "length") {
      done = true;
    }
    const responseValue = response.choices[0].message.content;
    output += responseValue;
    body.messages.push({
      role: "assistant",
      content: responseValue,
    });
    count += 1;
  }
  console.log(
    `Chat took ${count} calls to fully complete due to length (trace=${options.traceName ?? "notes"} model=${model}).`,
  );
  return output;
}
