import { compileSavedChatPrompt } from "./savedRecordingPrompt";
import type { MeetingNotesInput } from "../types/meeting-data";
import { config } from "./configService";
import type { SpanContext } from "@opentelemetry/api";
import { formatLongDate } from "../utils/time";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { generateOpenAIText } from "./openaiTextService";
import { getModelChoice } from "./modelFactory";
import { resolveChatParamsForRole } from "./openaiModelParams";
import type { ModelParamConfig } from "../config/types";
import { listRecentMeetingNamesForPrompt } from "./meetingNameService";

export type MeetingSummaries = {
  summarySentence?: string;
  summaryLabel?: string;
};

type MeetingSummaryInput = {
  savedPrompt?: MeetingNotesInput["savedSummary"];
  frozenModel?: NonNullable<
    MeetingNotesInput["frozenModels"]
  >["meetingSummary"];
  captureNotice?: string;
  signal?: AbortSignal;
  guildId?: string;
  notes: string;
  serverName: string;
  channelName: string;
  tags?: string[];
  now?: Date;
  meetingId?: string;
  previousSummarySentence?: string;
  previousSummaryLabel?: string;
  parentSpanContext?: SpanContext;
  modelParams?: ModelParamConfig;
  modelOverride?: string;
};

function normalizeSummarySentence(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const normalizedSentence = trimmed;
  if (!normalizedSentence) return undefined;
  const MAX_LENGTH = 320;
  return normalizedSentence.length > MAX_LENGTH
    ? `${normalizedSentence.slice(0, MAX_LENGTH - 3).trimEnd()}...`
    : normalizedSentence;
}

function normalizeSummaryLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 5) return undefined;
  if (!/^[A-Za-z0-9 ]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function parseMeetingSummaryResponse(
  content: string,
): MeetingSummaries | undefined {
  if (!content || !content.trim()) return undefined;
  try {
    const parsed = JSON.parse(content) as {
      summarySentence?: string;
      summaryLabel?: string;
    };
    const summarySentence = normalizeSummarySentence(parsed.summarySentence);
    const summaryLabel = normalizeSummaryLabel(parsed.summaryLabel);
    if (!summarySentence && !summaryLabel) {
      return undefined;
    }
    return {
      summarySentence,
      summaryLabel,
    };
  } catch (error) {
    console.error("Failed to parse meeting summaries:", error);
    return undefined;
  }
}

/**
 * Generates AI-based summaries for a meeting from notes and context.
 * Returns an empty object when the model response is missing or invalid.
 */
async function prepareSummaryPrompt(input: MeetingSummaryInput) {
  const now = input.now ?? new Date();
  const tagLine = input.tags?.length ? input.tags.join(", ") : "None";
  const previousSentence = input.previousSummarySentence?.trim();
  const previousLabel = input.previousSummaryLabel?.trim();
  const recentMeetingNames =
    input.savedPrompt?.recentMeetingNames ??
    (await listRecentMeetingNamesForPrompt({
      guildId: input.guildId,
      excludeMeetingId: input.meetingId,
      signal: input.signal,
    }));

  const previousSummaryBlock =
    previousSentence || previousLabel
      ? `Previous summary sentence: ${previousSentence || "(none)"}\nPrevious summary label: ${previousLabel || "(none)"}`
      : "Previous summaries: (none)";

  const variables = {
    todayLabel: formatLongDate(now),
    serverName: input.serverName,
    channelName: input.channelName,
    tagLine,
    recentMeetingNames,
    previousSummaryBlock,
    notes: input.notes,
  };
  const { messages, langfusePrompt } = input.savedPrompt
    ? compileSavedChatPrompt(input.savedPrompt.prompt, variables)
    : await getLangfuseChatPrompt({
        name: config.langfuse.meetingSummaryPromptName,
        variables,
      });
  if (input.captureNotice)
    messages.push({ role: "system", content: input.captureNotice });

  return { messages, langfusePrompt };
}
export async function generateMeetingSummaries(
  input: MeetingSummaryInput,
): Promise<MeetingSummaries> {
  input.signal?.throwIfAborted();
  const { messages, langfusePrompt } = await prepareSummaryPrompt(input);

  try {
    const overrides = input.modelOverride
      ? {
          meetingSummary: {
            provider: "openai" as const,
            model: input.modelOverride,
          },
        }
      : undefined;
    const modelChoice =
      input.frozenModel ?? getModelChoice("meetingSummary", overrides);
    const chatParams =
      input.frozenModel?.params ??
      resolveChatParamsForRole({
        role: "meetingSummary",
        model: modelChoice.model,
        config: input.modelParams,
      });
    input.signal?.throwIfAborted();
    const content = await generateOpenAIText({
      model: modelChoice.model,
      input: messages,
      modelParams: chatParams,
      format: { kind: "json_object" },
      maxOutputTokens: 160,
      signal: input.signal,
      tracing: {
        traceName: "meeting-summary",
        generationName: "meeting-summary",
        tags: ["feature:meeting_summary"],
        metadata: {
          serverName: input.serverName,
          channelName: input.channelName,
        },
        langfusePrompt,
        parentSpanContext: input.parentSpanContext,
      },
    });
    input.signal?.throwIfAborted();
    return parseMeetingSummaryResponse(content) ?? {};
  } catch (error) {
    input.signal?.throwIfAborted();
    console.error("Failed to generate meeting summaries:", error);
    return {};
  }
}
