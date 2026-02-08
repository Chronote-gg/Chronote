import type { CreateChatPromptBodyWithPlaceholders } from "@langfuse/client";
import type {
  ChatMessageWithPlaceholders,
  CreatePromptRequest,
  Prompt,
  PromptMeta,
  PromptMetaListResponse,
} from "@langfuse/core";
import { getLangfuseClient } from "../langfuse/client";

export type PromptType = "text" | "chat";
export type ChatMessage = {
  role: string;
  content: string;
};

export type LangfusePrompt = {
  name: string;
  type: PromptType;
  prompt: string | ChatMessage[];
  config: unknown;
  labels: string[];
  tags: string[];
  version?: number;
  commitMessage?: string | null;
};

export type { PromptMeta, PromptMetaListResponse };

function isChatMessage(
  message: ChatMessageWithPlaceholders,
): message is ChatMessageWithPlaceholders.Chatmessage {
  return (
    typeof (message as ChatMessage).role === "string" &&
    typeof (message as ChatMessage).content === "string"
  );
}

function toLangfusePrompt(prompt: Prompt): LangfusePrompt {
  if (prompt.type === "chat") {
    const messages = Array.isArray(prompt.prompt)
      ? prompt.prompt
          .filter(isChatMessage)
          .map((msg) => ({ role: msg.role, content: msg.content }))
      : [];

    return {
      name: prompt.name,
      type: "chat",
      prompt: messages,
      config: prompt.config ?? {},
      labels: prompt.labels ?? [],
      tags: prompt.tags ?? [],
      version: prompt.version,
      commitMessage: prompt.commitMessage ?? undefined,
    };
  }

  return {
    name: prompt.name,
    type: "text",
    prompt: typeof prompt.prompt === "string" ? prompt.prompt : "",
    config: prompt.config ?? {},
    labels: prompt.labels ?? [],
    tags: prompt.tags ?? [],
    version: prompt.version,
    commitMessage: prompt.commitMessage ?? undefined,
  };
}

export async function listPrompts(options: {
  name?: string;
  label?: string;
  tag?: string;
  page?: number;
  limit?: number;
  fromUpdatedAt?: string;
  toUpdatedAt?: string;
}): Promise<PromptMetaListResponse> {
  const client = getLangfuseClient();
  return client.api.prompts.list(options);
}

export async function getPrompt(options: {
  name: string;
  label?: string;
  version?: number;
}): Promise<LangfusePrompt> {
  const client = getLangfuseClient();
  const request =
    options.label || options.version != null
      ? {
          label: options.label,
          version: options.version,
        }
      : undefined;
  const prompt = await client.api.prompts.get(options.name, request);
  return toLangfusePrompt(prompt);
}

function isLangfuseNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    statusCode?: number;
    body?: { error?: string };
  };
  if (candidate.statusCode === 404) return true;
  if (candidate.name === "NotFoundError") return true;
  return candidate.body?.error === "LangfuseNotFoundError";
}

export async function tryGetPrompt(options: {
  name: string;
  label?: string;
  version?: number;
}): Promise<LangfusePrompt | null> {
  try {
    return await getPrompt(options);
  } catch (error) {
    if (isLangfuseNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export async function createPrompt(
  payload: Omit<LangfusePrompt, "version">,
): Promise<LangfusePrompt> {
  const client = getLangfuseClient();
  const labels = payload.labels ?? [];
  const tags = payload.tags ?? [];
  const commitMessage = payload.commitMessage ?? undefined;

  if (payload.type === "chat") {
    const request: CreateChatPromptBodyWithPlaceholders = {
      type: "chat",
      name: payload.name,
      prompt: payload.prompt as ChatMessage[],
      config: payload.config ?? {},
      labels,
      tags,
      commitMessage,
    };
    const created = await client.prompt.create(request);
    return toLangfusePrompt(created.promptResponse);
  }

  const request: CreatePromptRequest.Text = {
    type: "text",
    name: payload.name,
    prompt: typeof payload.prompt === "string" ? payload.prompt : "",
    config: payload.config ?? {},
    labels,
    tags,
    commitMessage,
  };
  const created = await client.prompt.create(request);
  return toLangfusePrompt(created.promptResponse);
}
