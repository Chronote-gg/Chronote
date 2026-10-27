import { isFixture } from "./fixtureInputService";
import { CONFIG_KEYS } from "../config/keys";
import { MeetingData } from "../types/meeting-data";
import { MeetingHistory, type DictionaryEntry } from "../types/db";
import { fetchChannelContext } from "./channelContextService";
import { listRecentMeetingsForChannelService } from "./meetingHistoryService";
import { config } from "./configService";
import { resolveConfigSnapshot } from "./unifiedConfigService";
import {
  buildDictionaryPromptLines,
  DEFAULT_DICTIONARY_BUDGETS,
  type DictionaryBudgets,
} from "../utils/dictionary";

export interface MeetingContextData {
  meetingContext?: string; // From /startmeeting command
  channelContext?: string; // From database
  serverContext?: string; // From database
  recentMeetings?: MeetingHistory[]; // From database (if memory enabled)
  dictionaryEntries?: DictionaryEntry[];
  dictionaryBudgets?: DictionaryBudgets;
}

function initialMeetingContext(meeting: MeetingData): MeetingContextData {
  const contextData: MeetingContextData = {};

  // Include meeting-specific context if provided
  if (meeting.meetingContext) {
    contextData.meetingContext = meeting.meetingContext;
  }

  if (meeting.dictionaryEntries && meeting.dictionaryEntries.length > 0) {
    contextData.dictionaryEntries = meeting.dictionaryEntries.map((entry) => ({
      ...entry,
    }));
  }
  if (meeting.runtimeConfig?.dictionary) {
    contextData.dictionaryBudgets = { ...meeting.runtimeConfig.dictionary };
  }

  return contextData;
}

/**
 * Build complete context data for a meeting
 * @param meeting The meeting data
 * @param includeMemory Whether to include recent meeting history
 * @returns Complete context data for the meeting
 */
export async function collectMeetingContext(
  meeting: MeetingData,
  includeMemory: boolean = false,
  options: {
    signal?: AbortSignal;
    strict?: boolean;
    memoryDepth?: number;
  } = {},
): Promise<{
  availability: "available" | "unavailable";
  data: MeetingContextData;
}> {
  if (isFixture(meeting)) return { availability: "available", data: {} };
  const contextData = initialMeetingContext(meeting);

  try {
    options.signal?.throwIfAborted();
    const serverSnapshot = await resolveConfigSnapshot(
      {
        guildId: meeting.guildId,
      },
      options,
    );
    const serverContextValue =
      serverSnapshot.values[CONFIG_KEYS.context.instructions]?.value;
    if (typeof serverContextValue === "string" && serverContextValue.trim()) {
      contextData.serverContext = serverContextValue;
    }

    // Fetch channel context
    const channelContext = await fetchChannelContext(
      meeting.guildId,
      meeting.voiceChannel.id,
      options.signal,
    );
    if (channelContext?.context) {
      contextData.channelContext = channelContext.context;
    }

    // Fetch recent meetings if memory is enabled
    if (includeMemory) {
      const memoryDepth = options.memoryDepth ?? config.context.memoryDepth;
      const recentMeetings = await listRecentMeetingsForChannelService(
        meeting.guildId,
        meeting.voiceChannel.id,
        memoryDepth,
        options.signal,
      );

      if (recentMeetings.length > 0) {
        contextData.recentMeetings = recentMeetings;
      }
    }
  } catch (error) {
    if (!options.strict)
      console.error("Error building meeting context:", error);
    return { availability: "unavailable", data: contextData };
  }

  return { availability: "available", data: contextData };
}

export async function buildMeetingContext(
  meeting: MeetingData,
  includeMemory = false,
): Promise<MeetingContextData> {
  return (await collectMeetingContext(meeting, includeMemory)).data;
}

/**
 * Format context data for inclusion in AI prompts
 * @param context The context data to format
 * @param promptType The type of prompt being generated
 * @returns Formatted context string for the prompt
 */
export function formatContextForPrompt(
  context: MeetingContextData,
  promptType: "transcription" | "notes" | "image",
  maxContextLength = config.context.maxContextLength,
): string {
  let formattedContext = "";

  // Add server context
  if (context.serverContext) {
    formattedContext += `\n**Server Context:** ${context.serverContext}\n`;
  }

  // Add channel context
  if (context.channelContext) {
    formattedContext += `\n**Channel Context:** ${context.channelContext}\n`;
  }

  // Add meeting-specific context
  if (context.meetingContext) {
    formattedContext += `\n**Meeting Context:** ${context.meetingContext}\n`;
  }

  if (
    context.dictionaryEntries &&
    context.dictionaryEntries.length > 0 &&
    promptType !== "image"
  ) {
    const budgets = context.dictionaryBudgets ?? DEFAULT_DICTIONARY_BUDGETS;
    const { contextLines } = buildDictionaryPromptLines(
      context.dictionaryEntries,
      budgets,
    );
    if (contextLines.length > 0) {
      formattedContext += `\n**Dictionary:**\n${contextLines.join("\n")}\n`;
    }
  }

  // Add recent meeting notes for relevant prompt types
  if (
    context.recentMeetings &&
    context.recentMeetings.length > 0 &&
    promptType === "notes"
  ) {
    formattedContext += "\n**Previous Meetings in This Channel:**\n";
    formattedContext +=
      "*These previous meetings provide context for understanding references and continuity.*\n";

    // Calculate available space for meeting history
    const remainingSpace = maxContextLength - formattedContext.length - 500; // Reserve 500 chars
    const spacePerMeeting = Math.floor(
      remainingSpace / context.recentMeetings.length,
    );

    for (const meeting of context.recentMeetings) {
      const meetingDate = new Date(meeting.timestamp).toLocaleDateString();
      let meetingInfo = `\n- Meeting on ${meetingDate}`;

      if (meeting.context) {
        meetingInfo += ` (Context: ${meeting.context})`;
      }

      if (meeting.notes) {
        // Use available space intelligently
        const availableSpace = spacePerMeeting - meetingInfo.length - 10;
        const truncatedNotes =
          meeting.notes.length > availableSpace
            ? meeting.notes.substring(0, availableSpace) + "..."
            : meeting.notes;
        meetingInfo += `:\n  ${truncatedNotes}`;
      }

      formattedContext += meetingInfo;
    }
  }

  // Truncate if context is too long
  if (formattedContext.length > maxContextLength) {
    formattedContext =
      formattedContext.substring(0, maxContextLength - 3) + "...";
  }

  return formattedContext;
}

/**
 * Check if memory features are enabled
 * @returns Whether memory features should be used
 */
export function isMemoryEnabled(): boolean {
  return config.context.enableMemory;
}
