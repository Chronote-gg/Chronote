import { listRecentMeetingsForGuildService } from "./meetingHistoryService";
import { config } from "./configService";
import { listDictionaryEntriesService } from "./dictionaryService";
import { normalizeTags, parseTags } from "../utils/tags";
import { buildUpgradeTextOnly } from "../utils/upgradePrompt";
import { ensureUserCanAccessMeeting } from "./meetingAccessService";
import { CONFIG_KEYS } from "../config/keys";
import { createOpenAIClient } from "./openaiClient";
import { buildModelOverrides, getModelChoice } from "./modelFactory";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { resolveModelChoicesForContext } from "./modelChoiceService";
import {
  resolveChatParamsForRole,
  resolveModelParamsForContext,
} from "./openaiModelParams";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";
import { resolveGuildSubscription } from "./subscriptionService";
import {
  buildDictionaryPromptLines,
  resolveDictionaryBudgets,
} from "../utils/dictionary";
import type { AskCitation } from "../types/ask";
import { buildAskCitations, stripCitationTags } from "./askCitations";

export type AskScope = "guild" | "channel";

export type AskHistoryMessage = {
  role: "user" | "chronote";
  text: string;
};

export interface AskRequest {
  guildId: string;
  channelId: string;
  question: string;
  tags?: string[];
  scope?: AskScope;
  maxMeetings?: number;
  history?: AskHistoryMessage[];
  viewerUserId?: string;
}

export interface AskResponse {
  answer: string;
  sourceMeetingIds?: string[];
  citations?: AskCitation[];
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
}

type MeetingSummary = Awaited<
  ReturnType<typeof listRecentMeetingsForGuildService>
>[number];

const scrubInternalIds = (text: string) =>
  text
    .replace(/\(id [0-9a-f-]{8,}\)/gi, "")
    .replace(/\bid [0-9a-f-]{8,}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

const ASK_MAX_COMPLETION_TOKENS = 800;
const ASK_MEETING_DELIMITER = "---";

const buildDictionaryBlock = async (guildId: string): Promise<string> => {
  try {
    const [entries, subscription] = await Promise.all([
      listDictionaryEntriesService(guildId),
      resolveGuildSubscription(guildId),
    ]);
    const snapshot = await resolveConfigSnapshot({
      guildId,
      tier: subscription.tier,
    });
    if (!entries.length) return "None.";
    const valuesByKey: Record<string, unknown> = {};
    Object.entries(snapshot.values).forEach(([key, entry]) => {
      valuesByKey[key] = entry.value;
    });
    const budgets = resolveDictionaryBudgets(valuesByKey, snapshot.tier);
    const { contextLines } = buildDictionaryPromptLines(entries, budgets);
    return contextLines.length > 0 ? contextLines.join("\n") : "None.";
  } catch (error) {
    console.warn("Failed to build dictionary block for Ask:", error);
    return "None.";
  }
};

const resolveAttendeeAccessEnabled = async (guildId: string) => {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.meetings.attendeeAccessEnabled,
    );
  } catch (error) {
    console.warn("Failed to resolve attendee access setting", {
      guildId,
      error,
    });
    return true;
  }
};

export const buildAskContextBlocks = (meetings: MeetingSummary[]) =>
  meetings.map((m, index) => {
    const meetingIndex = index + 1;
    const date = new Date(m.timestamp).toLocaleDateString();
    const tagLine = m.tags?.length
      ? `Tags: ${m.tags.join(", ")}`
      : "Tags: None";
    const statusLine = `Status: ${m.archivedAt ? "Archived" : "Active"}`;
    const notes = m.notes
      ? truncate(scrubInternalIds(m.notes), 900)
      : "(no notes)";
    return [
      `<meeting index="${meetingIndex}">`,
      `Date: ${date}`,
      tagLine,
      statusLine,
      `Notes: ${notes}`,
      `</meeting>`,
    ].join("\n");
  });

const filterMeetings = (
  meetings: MeetingSummary[],
  channelId: string,
  scope: AskScope,
  tags?: string[],
) => {
  let filtered = meetings;
  if (tags?.length) {
    filtered = filtered.filter(
      (m) => m.tags && m.tags.some((t) => tags.includes(t)),
    );
  }
  if (scope === "channel") {
    filtered = filtered.filter((m) => m.channelId === channelId);
  }
  return filtered;
};

const filterMeetingsByChannelAccess = async (
  meetings: MeetingSummary[],
  guildId: string,
  userId: string,
  attendeeOverrideEnabled: boolean,
) => {
  const visible: MeetingSummary[] = [];
  for (const meeting of meetings) {
    const allowed = await ensureUserCanAccessMeeting({
      guildId,
      meeting,
      userId,
      attendeeOverrideEnabled,
    });
    if (allowed) {
      visible.push(meeting);
    }
  }
  return visible;
};

const buildNoMeetingsResponse = (
  allMeetings: MeetingSummary[],
  maxMeetings: number,
): AskResponse => {
  if (!allMeetings.length) {
    return {
      answer:
        "I don't have any meetings yet. Start one with `/startmeeting` in Discord or enable auto-recording in Settings.",
      sourceMeetingIds: [],
      citations: [],
    };
  }
  const note =
    maxMeetings < config.ask.maxMeetings
      ? buildUpgradeTextOnly(
          "No relevant meetings found. Upgrade for deeper history.",
        )
      : "No relevant meetings found.";
  return { answer: note, sourceMeetingIds: [], citations: [] };
};

const buildMockResponse = (
  question: string,
  meetings: MeetingSummary[],
): AskResponse => {
  if (!meetings.length) {
    return {
      answer:
        "Mock mode: no meetings found yet. Start one with `/startmeeting` in Discord or enable auto-recording in Settings.",
      sourceMeetingIds: [],
      citations: [],
    };
  }
  const sourceMeetingIds = meetings.map(
    (meeting) => meeting.channelId_timestamp,
  );
  return {
    answer: `Mock answer for "${question}".`,
    sourceMeetingIds,
    citations: [],
  };
};

export async function answerQuestionService(
  req: AskRequest,
): Promise<AskResponse> {
  const { guildId, channelId, question } = req;
  const scope = req.scope ?? "guild";
  const tags = req.tags
    ? normalizeTags(parseTags(req.tags.join(",")))
    : undefined;

  const maxMeetings = req.maxMeetings ?? config.ask.maxMeetings;
  let attendeeOverrideEnabled = true;
  if (!config.mock.enabled && req.viewerUserId) {
    attendeeOverrideEnabled = await resolveAttendeeAccessEnabled(guildId);
  }
  const allMeetings = await listRecentMeetingsForGuildService(
    guildId,
    maxMeetings,
    { includeArchived: true },
  );
  const scopedMeetings = filterMeetings(allMeetings, channelId, scope, tags);
  const meetings = req.viewerUserId
    ? await filterMeetingsByChannelAccess(
        scopedMeetings,
        guildId,
        req.viewerUserId,
        attendeeOverrideEnabled,
      )
    : scopedMeetings;

  if (config.mock.enabled) {
    return buildMockResponse(question, meetings);
  }

  if (!meetings.length) {
    return buildNoMeetingsResponse(allMeetings, maxMeetings);
  }

  const dictionaryBlock = await buildDictionaryBlock(guildId);

  const sourceMeetingIds = meetings.map(
    (meeting) => meeting.channelId_timestamp,
  );
  const contextBlocks = buildAskContextBlocks(meetings);

  const history = (req.history ?? []).slice(-10);
  const historyBlock =
    history.length > 0
      ? history
          .map((msg) => {
            const label = msg.role === "chronote" ? "Chronote" : "User";
            return `${label}: ${stripCitationTags(msg.text)}`;
          })
          .join("\n")
      : "None.";

  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.askPromptName,
    variables: {
      question,
      contextBlocks: contextBlocks.join(`\n\n${ASK_MEETING_DELIMITER}\n\n`),
      historyBlock,
      dictionaryBlock,
      maxAnswerTokens: String(ASK_MAX_COMPLETION_TOKENS),
    },
  });

  const modelChoices = await resolveModelChoicesForContext({
    guildId,
    channelId,
    userId: req.viewerUserId,
  });
  const modelChoice = getModelChoice("ask", buildModelOverrides(modelChoices));
  const modelParams = await resolveModelParamsForContext({
    guildId,
    channelId,
    userId: req.viewerUserId,
  });
  const chatParams = resolveChatParamsForRole({
    role: "ask",
    model: modelChoice.model,
    config: modelParams.ask,
  });
  const openAIClient = createOpenAIClient({
    traceName: "ask",
    generationName: "ask",
    tags: ["feature:ask"],
    metadata: {
      guildId,
      channelId,
      scope,
    },
    langfusePrompt,
  });
  const completion = await openAIClient.chat.completions.create({
    model: modelChoice.model,
    messages,
    max_completion_tokens: ASK_MAX_COMPLETION_TOKENS,
    ...chatParams,
  });

  const answer = completion.choices[0].message.content ?? "No answer.";
  const citations = buildAskCitations({ text: answer, meetings });

  return {
    answer,
    sourceMeetingIds,
    citations,
  };
}
