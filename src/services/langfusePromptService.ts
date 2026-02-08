import { config } from "./configService";
import { getLangfuseClient, isLangfuseEnabled } from "./langfuseClient";

export type LangfusePromptMeta = {
  name: string;
  version: number;
  isFallback: boolean;
};

export type TextPromptResult = {
  prompt: string;
  langfusePrompt?: LangfusePromptMeta;
  source: "langfuse" | "fallback";
};

type ChatRole = "system" | "user" | "assistant";

const allowedChatRoles: Record<ChatRole, true> = {
  system: true,
  user: true,
  assistant: true,
};

const isChatRole = (value: string): value is ChatRole =>
  Object.prototype.hasOwnProperty.call(allowedChatRoles, value);

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ChatPromptResult = {
  messages: ChatMessage[];
  langfusePrompt?: LangfusePromptMeta;
  source: "langfuse" | "fallback";
};

function toTemplateVariables(
  values: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === null || value === undefined ? "" : String(value),
    ]),
  );
}

export async function getLangfuseTextPrompt(options: {
  name: string;
  label?: string;
  variables?: Record<string, string | number | boolean | null | undefined>;
}): Promise<TextPromptResult> {
  if (!isLangfuseEnabled()) {
    throw new Error(
      `Langfuse is required for prompt "${options.name}" but is not configured.`,
    );
  }

  const client = getLangfuseClient();
  if (!client) {
    throw new Error(
      `Langfuse client is unavailable for prompt "${options.name}".`,
    );
  }

  const label = options.label ?? config.langfuse.promptLabel;
  const cacheTtlSeconds = Math.floor(
    Math.max(config.langfuse.promptCacheTtlMs, 0) / 1000,
  );

  try {
    const prompt = await client.prompt.get(options.name, {
      label,
      cacheTtlSeconds,
    });
    const promptMeta: LangfusePromptMeta = {
      name: prompt.name,
      version: prompt.version,
      isFallback: prompt.isFallback,
    };
    const compiledVariables = toTemplateVariables(options.variables ?? {});
    return {
      prompt: prompt.compile(compiledVariables),
      langfusePrompt: promptMeta,
      source: "langfuse",
    };
  } catch (error) {
    throw new Error(
      `Langfuse prompt fetch failed for "${options.name}" (${label}).`,
      { cause: error },
    );
  }
}

export async function getLangfuseChatPrompt(options: {
  name: string;
  label?: string;
  variables?: Record<string, string | number | boolean | null | undefined>;
}): Promise<ChatPromptResult> {
  if (!isLangfuseEnabled()) {
    throw new Error(
      `Langfuse is required for prompt "${options.name}" but is not configured.`,
    );
  }

  const client = getLangfuseClient();
  if (!client) {
    throw new Error(
      `Langfuse client is unavailable for prompt "${options.name}".`,
    );
  }

  const label = options.label ?? config.langfuse.promptLabel;
  const cacheTtlSeconds = Math.floor(
    Math.max(config.langfuse.promptCacheTtlMs, 0) / 1000,
  );

  try {
    const prompt = await client.prompt.get(options.name, {
      label,
      cacheTtlSeconds,
    });
    const promptMeta: LangfusePromptMeta = {
      name: prompt.name,
      version: prompt.version,
      isFallback: prompt.isFallback,
    };
    const compiledVariables = toTemplateVariables(options.variables ?? {});
    const compiled = prompt.compile(compiledVariables);
    if (!Array.isArray(compiled)) {
      throw new Error(
        `Langfuse prompt "${options.name}" is not a chat prompt.`,
      );
    }
    const messages = compiled.map((message) => {
      if (
        !message ||
        typeof message.role !== "string" ||
        typeof message.content !== "string"
      ) {
        throw new Error(
          `Langfuse chat prompt "${options.name}" has invalid messages.`,
        );
      }
      if (!isChatRole(message.role)) {
        throw new Error(
          `Langfuse chat prompt "${options.name}" has unsupported role "${message.role}".`,
        );
      }
      return { role: message.role, content: message.content };
    });
    return {
      messages,
      langfusePrompt: promptMeta,
      source: "langfuse",
    };
  } catch (error) {
    throw new Error(
      `Langfuse prompt fetch failed for "${options.name}" (${label}).`,
      { cause: error },
    );
  }
}

const formatPromptError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const buildPromptVerificationList = () => {
  const prompts = new Set<string>([
    config.langfuse.askPromptName,
    config.langfuse.meetingSummaryPromptName,
    config.langfuse.notesPromptName,
    config.langfuse.transcriptionPromptName,
    config.langfuse.transcriptionCleanupPromptName,
    config.langfuse.transcriptionCoalescePromptName,
    config.langfuse.imagePromptName,
    config.langfuse.notesCorrectionPromptName,
  ]);

  if (config.notes.longStoryTestMode) {
    prompts.add(config.langfuse.notesLongStoryPromptName);
  }
  if (config.context.testMode) {
    prompts.add(config.langfuse.notesContextTestPromptName);
  }
  if (config.liveVoice.mode !== "off") {
    prompts.add(config.langfuse.liveVoiceGatePromptName);
    prompts.add(config.langfuse.liveVoiceConfirmPromptName);
    prompts.add(config.langfuse.liveVoiceResponderPromptName);
  }

  return Array.from(prompts);
};

export async function verifyLangfusePrompts(): Promise<void> {
  if (config.mock.enabled) {
    return;
  }

  if (!isLangfuseEnabled()) {
    if (config.server.nodeEnv === "production") {
      throw new Error(
        "Langfuse is required in production but LANGFUSE_PUBLIC_KEY/LANGFUSE_SECRET_KEY are missing.",
      );
    }
    return;
  }

  const client = getLangfuseClient();
  if (!client) {
    throw new Error("Langfuse client is unavailable.");
  }

  const label = config.langfuse.promptLabel;
  const cacheTtlSeconds = Math.floor(
    Math.max(config.langfuse.promptCacheTtlMs, 0) / 1000,
  );
  const promptNames = buildPromptVerificationList();
  const failures: string[] = [];

  for (const name of promptNames) {
    try {
      await client.prompt.get(name, {
        label,
        cacheTtlSeconds,
      });
    } catch (error) {
      failures.push(`${name}: ${formatPromptError(error)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Langfuse prompt verification failed (${label}): ${failures.join("; ")}`,
    );
  }
}
