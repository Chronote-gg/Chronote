import type OpenAI from "openai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Usage,
} from "@mariozechner/pi-ai";
import type {
  Response,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { resolveChatParamsForRole } from "./openaiModelParams";
import { buildOpenAISafetyIdentifier } from "./openaiClient";

export type PrivateAssistantMessage = AssistantMessage & {
  responseOutput?: ResponseInputItem[];
};
export const emptyAskUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export function createAskAssistantMessage(
  model: string,
): PrivateAssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model,
    usage: emptyAskUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
function assistantInputPart(
  part: AssistantMessage["content"][number],
): ResponseInputItem[] {
  if (part.type === "text") return [{ role: "assistant", content: part.text }];
  if (part.type === "toolCall")
    return [
      {
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: JSON.stringify(part.arguments),
      },
    ];
  return [];
}
function messageInput(message: Message): ResponseInputItem[] {
  if (message.role === "user")
    return [{ role: "user", content: message.content as string }];
  if (message.role === "toolResult")
    return [
      {
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      },
    ];
  return (
    (message as PrivateAssistantMessage).responseOutput ??
    message.content.flatMap(assistantInputPart)
  );
}
function responseInput(context: Context): ResponseInputItem[] {
  return [
    { role: "system", content: context.systemPrompt ?? "" },
    ...context.messages.flatMap(messageInput),
  ];
}
function outputContent(item: ResponseOutputItem): AssistantMessage["content"] {
  if (item.type === "function_call")
    return [
      {
        type: "toolCall",
        id: item.call_id,
        name: item.name,
        arguments: JSON.parse(item.arguments),
      },
    ];
  if (item.type !== "message") return [];
  return item.content.flatMap((part) => {
    if (part.type === "refusal") throw new Error("Ask generation refused.");
    return part.type === "output_text"
      ? [{ type: "text" as const, text: part.text }]
      : [];
  });
}
function pushTextDelta(
  stream: AssistantMessageEventStream,
  message: PrivateAssistantMessage,
  delta: string,
) {
  let part = message.content.find((item) => item.type === "text");
  if (!part) {
    part = { type: "text", text: "" };
    message.content.push(part);
  }
  part.text += delta;
  stream.push({
    type: "text_delta",
    contentIndex: message.content.indexOf(part),
    delta,
    partial: message,
  });
}
async function consumeResponse(
  events: AsyncIterable<ResponseStreamEvent>,
  stream: AssistantMessageEventStream,
  message: PrivateAssistantMessage,
  signal: AbortSignal,
) {
  let final: Response | undefined;
  for await (const event of events) {
    signal.throwIfAborted();
    switch (event.type) {
      case "response.output_text.delta":
        pushTextDelta(stream, message, event.delta);
        break;
      case "response.completed":
        final = event.response;
        break;
      case "response.failed":
      case "response.incomplete":
      case "error":
        throw new Error("Ask response failed or exceeded its output budget.");
    }
  }
  if (!final || final.status !== "completed")
    throw new Error("Ask response did not complete.");
  return final;
}
function completeMessage(
  message: PrivateAssistantMessage,
  final: Response,
  usage: Usage,
) {
  message.responseOutput = toResponseInputItems(final.output);
  message.content = final.output.flatMap(outputContent);
  const cached = final.usage?.input_tokens_details?.cached_tokens ?? 0;
  message.usage = {
    ...emptyAskUsage(),
    input: (final.usage?.input_tokens ?? 0) - cached,
    cacheRead: cached,
    output: final.usage?.output_tokens ?? 0,
    totalTokens: final.usage?.total_tokens ?? 0,
  };
  usage.input += message.usage.input;
  usage.output += message.usage.output;
  usage.cacheRead += cached;
  usage.totalTokens += message.usage.totalTokens;
  message.stopReason = message.content.some((part) => part.type === "toolCall")
    ? "toolUse"
    : "stop";
  return message.stopReason;
}
type ResponsesStreamOptions = {
  client: OpenAI;
  pi: typeof import("@mariozechner/pi-ai");
  model: string;
  modelParams: ReturnType<typeof resolveChatParamsForRole>;
  signal: AbortSignal;
  userId: string;
  maxOutputTokens: number;
  usage: Usage;
};
async function requestResponse(
  options: ResponsesStreamOptions,
  context: Context,
  signal: AbortSignal,
) {
  const { modelParams } = options;
  return options.client.responses.create(
    {
      model: options.model,
      input: responseInput(context),
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: options.maxOutputTokens,
      reasoning: modelParams.reasoning_effort
        ? { effort: modelParams.reasoning_effort }
        : undefined,
      temperature: modelParams.temperature,
      text: modelParams.verbosity
        ? { verbosity: modelParams.verbosity }
        : undefined,
      safety_identifier: buildOpenAISafetyIdentifier(options.userId),
      tools: (context.tools ?? []).map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as Record<string, unknown>,
        strict: false,
      })),
    },
    { signal },
  );
}
async function runResponseStream(
  options: ResponsesStreamOptions,
  context: Context,
  requestOptions: Parameters<StreamFn>[2],
  stream: AssistantMessageEventStream,
  message: PrivateAssistantMessage,
) {
  try {
    options.signal.throwIfAborted();
    const signal = AbortSignal.any([
      options.signal,
      ...(requestOptions?.signal ? [requestOptions.signal] : []),
    ]);
    const events = await requestResponse(options, context, signal);
    stream.push({ type: "start", partial: message });
    const final = await consumeResponse(events, stream, message, signal);
    const reason = completeMessage(message, final, options.usage);
    stream.push({
      type: "done",
      reason,
      message,
    });
  } catch (cause) {
    message.stopReason =
      options.signal.aborted || requestOptions?.signal?.aborted
        ? "aborted"
        : "error";
    message.errorMessage =
      cause instanceof Error ? cause.message : "Ask generation failed.";
    stream.push({ type: "error", reason: message.stopReason, error: message });
  }
}
export function createAskResponsesStream(
  options: ResponsesStreamOptions,
): StreamFn {
  return (_model, context, requestOptions) => {
    const stream = options.pi.createAssistantMessageEventStream();
    void runResponseStream(
      options,
      context,
      requestOptions,
      stream,
      createAskAssistantMessage(options.model),
    );
    return stream;
  };
}
