import type { MeetingHistory } from "../types/db";
import {
  listAllMeetingsForGuildService,
  listRecentMeetingsForGuildService,
} from "./meetingHistoryService";

const MEETING_NAME_WORD_LIMIT = 5;
const MEETING_NAME_PATTERN = /^[A-Za-z0-9 ]+$/;
const MEETING_NAME_SUGGESTION_LIMIT = 40;

export const MEETING_NAME_REQUIREMENTS =
  "Meeting names must be 5 words or fewer and use only letters, numbers, and spaces.";

const collapseWhitespace = (value: string) => value.trim().replace(/\s+/g, " ");

export function normalizeMeetingName(
  value?: string | null,
): string | undefined {
  if (!value) return undefined;
  const trimmed = collapseWhitespace(value);
  if (!trimmed) return undefined;
  if (!MEETING_NAME_PATTERN.test(trimmed)) return undefined;
  const words = trimmed.split(" ").filter(Boolean);
  if (words.length > MEETING_NAME_WORD_LIMIT) return undefined;
  return trimmed;
}

export function buildMeetingNameKey(value: string): string {
  return collapseWhitespace(value).toLowerCase();
}

export function isMeetingNameAutoSynced(
  meetingName?: string | null,
  summaryLabel?: string | null,
): boolean {
  if (!meetingName) return true;
  if (!summaryLabel) return false;
  const normalizedMeeting = normalizeMeetingName(meetingName);
  const normalizedLabel = normalizeMeetingName(summaryLabel);
  if (!normalizedMeeting || !normalizedLabel) return false;
  return (
    buildMeetingNameKey(normalizedMeeting) ===
    buildMeetingNameKey(normalizedLabel)
  );
}

function resolveMeetingNameCandidate(
  meeting: MeetingHistory,
): string | undefined {
  return normalizeMeetingName(meeting.meetingName ?? meeting.summaryLabel);
}

function trimNameForSuffix(value: string): string {
  const tokens = collapseWhitespace(value).split(" ").filter(Boolean);
  if (tokens.length >= MEETING_NAME_WORD_LIMIT) {
    return tokens.slice(0, MEETING_NAME_WORD_LIMIT - 1).join(" ");
  }
  return tokens.join(" ");
}

export async function resolveUniqueMeetingName(params: {
  guildId: string;
  desiredName: string;
  excludeMeetingId?: string;
}): Promise<string> {
  const meetings = await listAllMeetingsForGuildService(params.guildId);
  const existing = new Set<string>();
  for (const meeting of meetings) {
    if (
      params.excludeMeetingId &&
      meeting.meetingId === params.excludeMeetingId
    ) {
      continue;
    }
    const candidate = resolveMeetingNameCandidate(meeting);
    if (!candidate) continue;
    existing.add(buildMeetingNameKey(candidate));
  }

  const desiredKey = buildMeetingNameKey(params.desiredName);
  if (!existing.has(desiredKey)) {
    return params.desiredName;
  }

  const baseName = trimNameForSuffix(params.desiredName);
  let suffix = 2;
  let candidate = `${baseName} ${suffix}`;
  while (existing.has(buildMeetingNameKey(candidate))) {
    suffix += 1;
    candidate = `${baseName} ${suffix}`;
  }
  return candidate;
}

export async function resolveMeetingNameFromSummary(params: {
  guildId: string;
  meetingId?: string;
  summaryLabel?: string | null;
}): Promise<string | undefined> {
  const normalized = normalizeMeetingName(params.summaryLabel ?? undefined);
  if (!normalized) return undefined;
  return resolveUniqueMeetingName({
    guildId: params.guildId,
    desiredName: normalized,
    excludeMeetingId: params.meetingId,
  });
}

export async function listRecentMeetingNamesForPrompt(params: {
  guildId?: string;
  excludeMeetingId?: string;
  limit?: number;
  signal?: AbortSignal;
}): Promise<string> {
  if (!params.guildId) return "None.";
  const limit = params.limit ?? MEETING_NAME_SUGGESTION_LIMIT;
  const meetings = await listRecentMeetingsForGuildService(
    params.guildId,
    limit,
    {
      includeArchived: true,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  const names: string[] = [];
  const seen = new Set<string>();
  for (const meeting of meetings) {
    if (
      params.excludeMeetingId &&
      meeting.meetingId === params.excludeMeetingId
    ) {
      continue;
    }
    const candidate = resolveMeetingNameCandidate(meeting);
    if (!candidate) continue;
    const key = buildMeetingNameKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(candidate);
  }
  if (names.length === 0) {
    return "None.";
  }
  return names.map((name) => `- ${name}`).join("\n");
}
