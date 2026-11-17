import { createHash } from "node:crypto";
import { z } from "zod";
import { getMeetingHistoryRepository } from "../repositories/meetingHistoryRepository";
import { queryMeetingSearchCandidates } from "../repositories/meetingSearchRepository";
import type { MeetingHistory } from "../types/db";
import {
  MeetingSearchError,
  type MeetingRef,
  type MeetingSearchPrincipal,
  type MeetingSearchFilters,
  type MeetingSearchRequest,
  type TranscriptSearchRequest,
  type MeetingSearchHit,
  type TranscriptSearchHit,
  type SearchCoverage,
  type MeetingSearchCandidate,
} from "../types/meetingSearch";
import { signConsentToken, readConsentToken } from "../utils/consentToken";
import type { TranscriptPayload } from "../types/transcript";
import { fetchJsonFromS3 } from "./storageService";
import { config } from "./configService";
import { ensureMcpMeetingAccess } from "./mcpMeetingAccess";
import { McpMeetingAccessError } from "./mcpMeetingErrors";
import { listMcpMyMeetings } from "./mcpMeetingService";
import { createMeetingMentionReplacer } from "./meetingMentionService";
import { projectMeetingCapture } from "../utils/meetingCaptureNotice";
import { isPersonalMeeting } from "../utils/meetingOwnership";
import { resolveMeetingArtifactAccess } from "./meetingArtifactAccessService";
import { meetingSearchSourceRevision } from "./meetingSearchProjectionService";
import { embedSearchText } from "./searchEmbeddingService";

const refSchema = z.object({
  serverId: z.string().min(1),
  id: z.string().min(1),
});
const filtersSchema = z.object({
  serverIds: z.array(z.string().min(1)).nonempty().optional(),
  meetingIds: z.array(refSchema).nonempty().optional(),
  from: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  channelId: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
  archive: z.enum(["active", "all", "archived"]).default("active"),
});
const candidateSchema = z.object({
  key: z.string(),
  meeting: refSchema,
  sourceRevision: z.string(),
  transcriptHash: z.string().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
});
const cursorSchema = z.object({
  expiresAt: z.number(),
  fingerprint: z.string(),
  browse: z.string().optional(),
  pending: z.array(refSchema),
  done: z.boolean(),
  offset: z.number().int().nonnegative().default(0),
  candidates: z.array(candidateSchema).optional(),
  nextToken: z.string().optional(),
  windowLimited: z.boolean().optional(),
});
type Cursor = z.infer<typeof cursorSchema>;
const sameRef = (a: MeetingRef, b: MeetingRef) =>
  a.serverId === b.serverId && a.id === b.id;
const refOf = (meeting: MeetingHistory): MeetingRef => ({
  serverId: meeting.guildId,
  id: meeting.channelId_timestamp,
});
const secret = () => {
  const value = config.server.sessionSecret || config.server.oauthSecret;
  if (!value)
    throw new MeetingSearchError(
      "temporarily_unavailable",
      "Search cursor signing is unavailable.",
      true,
    );
  return value;
};
function parseFilters(filters?: MeetingSearchFilters) {
  const result = filtersSchema.safeParse(filters ?? {});
  if (
    !result.success ||
    (result.data.from &&
      result.data.before &&
      result.data.from >= result.data.before)
  )
    throw new MeetingSearchError(
      "invalid_argument",
      "Invalid meeting filters.",
    );
  const value = result.data;
  value.serverIds = value.serverIds
    ? [...new Set(value.serverIds)].sort()
    : undefined;
  value.tags = value.tags
    ? [...new Set(value.tags.map((tag) => tag.toLowerCase()))].sort()
    : undefined;
  value.meetingIds = value.meetingIds
    ? [
        ...new Map(
          value.meetingIds.map((ref) => [JSON.stringify(ref), ref]),
        ).values(),
      ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    : undefined;
  return value;
}
function pageLimit(pageSize = 10) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 25)
    throw new MeetingSearchError(
      "invalid_argument",
      "pageSize must be between 1 and 25.",
    );
  return pageSize;
}
function matchesChannel(meeting: MeetingHistory, channelId?: string) {
  return (
    !channelId ||
    channelId ===
      (meeting.channelId?.trim() ||
        meeting.channelId_timestamp.split("#")[0]) ||
    channelId ===
      (meeting.textChannelId?.trim() || meeting.notesChannelId?.trim())
  );
}
function matches(meeting: MeetingHistory, filters: MeetingSearchFilters) {
  const ref = refOf(meeting);
  return (
    (!filters.serverIds || filters.serverIds.includes(meeting.guildId)) &&
    (!filters.meetingIds ||
      filters.meetingIds.some((id) => sameRef(id, ref))) &&
    (!filters.from || meeting.timestamp >= filters.from) &&
    (!filters.before || meeting.timestamp < filters.before) &&
    matchesChannel(meeting, filters.channelId) &&
    (filters.archive === "all" ||
      Boolean(meeting.archivedAt) === (filters.archive === "archived")) &&
    (filters.tags ?? []).every((tag) =>
      (meeting.tags ?? []).some(
        (value) => value.toLowerCase() === tag.toLowerCase(),
      ),
    )
  );
}
function matchesPrincipalScope(
  principal: MeetingSearchPrincipal,
  meeting: MeetingHistory,
) {
  const personal = isPersonalMeeting(meeting);
  if (principal.scope?.kind === "personal") return personal;
  if (principal.scope?.kind === "all" && personal) return true;
  return (
    principal.serverIds.includes(meeting.guildId) &&
    (principal.scope?.kind !== "guild" ||
      (!personal && principal.scope.serverId === meeting.guildId))
  );
}
function matchesTokenRestriction(
  principal: MeetingSearchPrincipal,
  meeting: MeetingHistory,
) {
  const restriction = principal.restriction;
  if (!restriction) return true;
  const voiceChannelId =
    meeting.channelId?.trim() || meeting.channelId_timestamp.split("#")[0];
  return (
    !isPersonalMeeting(meeting) &&
    restriction.guildId === meeting.guildId &&
    (!restriction.channelIds || restriction.channelIds.includes(voiceChannelId))
  );
}
async function canonical(
  principal: MeetingSearchPrincipal,
  ref: MeetingRef,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (principal.restriction && ref.serverId !== principal.restriction.guildId)
    throw new MeetingSearchError("not_available", "Meeting is unavailable.");
  let meeting: MeetingHistory | undefined;
  try {
    meeting = await getMeetingHistoryRepository().getStrong(
      { guildId: ref.serverId, channelId_timestamp: ref.id },
      signal,
    );
  } catch (error) {
    // One incomplete history row must not block access to other meetings.
    if (error instanceof z.ZodError)
      throw new MeetingSearchError("not_available", "Meeting is unavailable.");
    throw error;
  }
  if (
    !meeting ||
    meeting.status === "cancelled" ||
    !matchesTokenRestriction(principal, meeting) ||
    !matchesPrincipalScope(principal, meeting) ||
    !matches(meeting, {
      channelId: principal.channelId,
      tags: principal.tags,
      archive: "all",
    })
  )
    throw new MeetingSearchError("not_available", "Meeting is unavailable.");
  try {
    await ensureMcpMeetingAccess({
      guildId: ref.serverId,
      userId: principal.userId,
      meeting,
      restricted: Boolean(principal.restriction),
    });
  } catch (error) {
    if (
      error instanceof McpMeetingAccessError &&
      ["forbidden", "not_found"].includes(error.code)
    )
      throw new MeetingSearchError("not_available", "Meeting is unavailable.");
    throw error;
  }
  return meeting;
}
export async function authorizeMeetingSearchSource(
  principal: MeetingSearchPrincipal,
  ref: MeetingRef,
  revision?: string,
  source: "notes" | "transcript" = "notes",
  signal?: AbortSignal,
) {
  const meeting = await canonical(principal, ref, signal);
  if (
    source === "transcript" &&
    !(await resolveMeetingArtifactAccess(meeting)).transcriptAccessEnabled
  )
    throw new MeetingSearchError(
      "source_unavailable",
      "Transcript is unavailable.",
    );
  const content =
    source === "transcript"
      ? meeting.transcriptS3Key
        ? ((await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key))
            ?.text ?? "")
        : (meeting.transcript ?? "")
      : undefined;
  if (content === "")
    throw new MeetingSearchError(
      "source_unavailable",
      "Transcript is unavailable.",
    );
  const current =
    meetingSearchSourceRevision(meeting) +
    (content === undefined
      ? ""
      : ":" + createHash("sha256").update(content).digest("hex"));
  if (revision && revision !== current)
    throw new MeetingSearchError(
      "source_changed",
      "Meeting changed. Read it again.",
    );
  return current;
}
export async function readMeetingNotesForUser(
  principal: MeetingSearchPrincipal,
  input: { meeting: MeetingRef },
  signal?: AbortSignal,
): Promise<MeetingSearchHit> {
  const meeting = await canonical(principal, input.meeting, signal);
  const revision = meetingSearchSourceRevision(meeting);
  const display = await createMeetingMentionReplacer(meeting);
  const artifactAccess = await resolveMeetingArtifactAccess(meeting);
  await authorizeMeetingSearchSource(
    principal,
    input.meeting,
    revision,
    "notes",
    signal,
  );
  return {
    meeting: input.meeting,
    title: display.toText(
      meeting.meetingName ?? meeting.summaryLabel ?? "Meeting",
    ),
    startedAt: meeting.timestamp,
    tags: meeting.tags ?? [],
    archived: Boolean(meeting.archivedAt),
    summary: meeting.summarySentence
      ? display.toText(meeting.summarySentence)
      : undefined,
    notes: display.toText(meeting.notes ?? ""),
    notesRevision: revision,
    transcriptAvailable:
      artifactAccess.transcriptAccessEnabled &&
      Boolean(meeting.transcriptS3Key || meeting.transcript),
  };
}
const passageSchema = z.object({
  expiresAt: z.number(),
  meeting: refSchema,
  revision: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
});
function readPassageLocator(
  meeting: MeetingRef,
  locator: string | undefined,
  revision: string,
) {
  const state = locator
    ? readConsentToken(
        locator,
        secret(),
        (value): value is z.infer<typeof passageSchema> =>
          passageSchema.safeParse(value).success,
      )
    : undefined;
  if (locator && (!state || !sameRef(state.meeting, meeting)))
    throw new MeetingSearchError(
      "invalid_cursor",
      "Invalid transcript locator.",
    );
  if (state && state.revision !== revision)
    throw new MeetingSearchError(
      "source_changed",
      "Transcript changed. Search again.",
    );
  return state;
}
async function loadTranscriptSnapshot(
  principal: MeetingSearchPrincipal,
  ref: MeetingRef,
  revision: string,
  signal?: AbortSignal,
) {
  const meeting = await canonical(principal, ref, signal);
  const text = meeting.transcriptS3Key
    ? (await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key))?.text
    : meeting.transcript;
  if (!text)
    throw new MeetingSearchError(
      "source_unavailable",
      "Transcript is unavailable.",
    );
  const actualRevision =
    meetingSearchSourceRevision(meeting) +
    ":" +
    createHash("sha256").update(text).digest("hex");
  if (actualRevision !== revision)
    throw new MeetingSearchError(
      "source_changed",
      "Transcript changed. Search again.",
    );
  return { meeting, text };
}
function sliceStoredTranscript(
  text: string,
  start: number,
  maxChars: number,
  preserveWindow: boolean,
) {
  const offset = Math.min(start, text.length);
  let end = Math.min(offset + Math.min(8000, maxChars), text.length);
  if (end === text.length) return { offset, end };
  if (/[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const paragraph = text.lastIndexOf("\n\n", end);
  if (!preserveWindow && paragraph > offset) end = paragraph + 2;
  for (const match of text
    .slice(Math.max(offset, end - 32), end + 32)
    .matchAll(/<@[!&]?\d+>/g)) {
    const mentionStart = Math.max(offset, end - 32) + match.index;
    if (mentionStart < end && mentionStart + match[0].length > end)
      end =
        mentionStart > offset ? mentionStart : mentionStart + match[0].length;
  }
  return { offset, end };
}
export async function readTranscriptPassageForUser(
  principal: MeetingSearchPrincipal,
  input: { meeting: MeetingRef; passageRef?: string; cursor?: string },
  signal?: AbortSignal,
) {
  if (input.passageRef && input.cursor)
    throw new MeetingSearchError(
      "invalid_argument",
      "Choose a passage or continuation.",
    );
  const revision = await authorizeMeetingSearchSource(
    principal,
    input.meeting,
    undefined,
    "transcript",
    signal,
  );
  const locator = input.passageRef ?? input.cursor;
  const state = readPassageLocator(input.meeting, locator, revision);
  const start = state?.start ?? 0;
  const { meeting, text } = await loadTranscriptSnapshot(
    principal,
    input.meeting,
    revision,
    signal,
  );
  const { offset, end } = sliceStoredTranscript(
    text,
    start,
    state ? state.end - start : 8000,
    Boolean(input.passageRef),
  );
  const display = await createMeetingMentionReplacer(meeting);
  const result = {
    transcript: display.toText(text.slice(offset, end)),
    offset,
    totalChars: text.length,
    nextOffset: end < text.length ? end : undefined,
  };
  await authorizeMeetingSearchSource(
    principal,
    input.meeting,
    revision,
    "transcript",
    signal,
  );
  const nextCursor =
    result.nextOffset == null
      ? null
      : signConsentToken(
          {
            meeting: input.meeting,
            revision,
            start: result.nextOffset,
            end: result.nextOffset + 8000,
            expiresAt: Date.now() + 3600000,
          },
          secret(),
        );
  return {
    meeting: input.meeting,
    revision,
    text: result.transcript,
    ...projectMeetingCapture(meeting),
    location: {
      start: result.offset,
      end: result.nextOffset ?? result.totalChars,
    },
    passageRef:
      locator ??
      signConsentToken(
        {
          meeting: input.meeting,
          revision,
          start,
          end: start + 8000,
          expiresAt: Date.now() + 3600000,
        },
        secret(),
      ),
    nextCursor,
  };
}
function restoreCursor(
  principal: MeetingSearchPrincipal,
  input: { cursor?: string },
  binding: unknown,
): Cursor {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        principal.userId,
        [...principal.serverIds].sort(),
        principal.scope,
        principal.restriction,
        principal.channelId,
        principal.tags,
        config.search.meetingIndexArn,
        config.search.transcriptIndexArn,
        binding,
      ]),
    )
    .digest("hex");
  if (!input.cursor)
    return {
      fingerprint,
      expiresAt: Date.now() + 3600000,
      pending: [],
      done: false,
      offset: 0,
    };
  const state = readConsentToken(
    input.cursor,
    secret(),
    (value): value is Cursor => cursorSchema.safeParse(value).success,
  );
  if (!state || state.fingerprint !== fingerprint)
    throw new MeetingSearchError(
      "invalid_cursor",
      "Search cursor does not match this request.",
    );
  return state;
}
function nextSearchCursor(state: Cursor) {
  return state.pending.length || !state.done
    ? signConsentToken(state, secret())
    : null;
}
async function discover(
  principal: MeetingSearchPrincipal,
  state: Cursor,
  filters: MeetingSearchFilters,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (state.pending.length || state.done) return;
  const page = await listMcpMyMeetings({
    userId: principal.userId,
    mode: "accessible",
    range: "all",
    limit: 25,
    cursor: state.browse,
    ...(principal.scope
      ? { browse: { scope: principal.scope, attendedOnly: false } }
      : { serverIds: principal.serverIds }),
    restriction: principal.restriction,
    includeArchived: filters.archive === "all",
    archivedOnly: filters.archive === "archived",
  });
  state.browse = page.nextCursor ?? undefined;
  state.done = !page.nextCursor;
  state.pending = page.meetings.map((meeting) => ({
    serverId: meeting.serverId,
    id: meeting.id,
  }));
}
async function readListedMeeting(
  principal: MeetingSearchPrincipal,
  ref: MeetingRef,
  filters: MeetingSearchFilters,
  signal?: AbortSignal,
) {
  try {
    const current = await canonical(principal, ref, signal);
    if (!matches(current, filters)) return;
    const hit = await readMeetingNotesForUser(
      principal,
      { meeting: ref },
      signal,
    );
    return {
      meeting: hit.meeting,
      title: hit.title,
      startedAt: hit.startedAt,
      tags: hit.tags,
      archived: hit.archived,
      summary: hit.summary,
      transcriptAvailable: hit.transcriptAvailable,
    };
  } catch (error) {
    if (error instanceof MeetingSearchError && error.code === "not_available")
      return;
    throw error;
  }
}
export async function listMeetingsForUser(
  principal: MeetingSearchPrincipal,
  input: { filters?: MeetingSearchFilters; pageSize?: number; cursor?: string },
  signal?: AbortSignal,
) {
  const filters = parseFilters(input.filters);
  const limit = pageLimit(input.pageSize);
  const state = restoreCursor(principal, input, ["list", filters, limit]);
  const meetings: Omit<MeetingSearchHit, "notes" | "notesRevision">[] = [];
  const deadline = Date.now() + 10000;
  while (meetings.length < limit && Date.now() < deadline) {
    await discover(principal, state, filters, signal);
    const ref = state.pending.shift();
    if (!ref) {
      if (state.done) break;
      continue;
    }
    const meeting = await readListedMeeting(principal, ref, filters, signal);
    if (meeting) meetings.push(meeting);
  }
  return {
    meetings,
    nextCursor: nextSearchCursor(state),
    coverage: {
      status: "ready",
      semanticStatus: "unavailable",
      ranking: "authorized_partition_order",
    } satisfies SearchCoverage,
  };
}
async function authorizeSearchPartition(
  principal: MeetingSearchPrincipal,
  refs: MeetingRef[],
  filters: MeetingSearchFilters,
  kind: "meeting" | "transcript",
  signal?: AbortSignal,
) {
  const authorized: MeetingRef[] = [];
  for (const ref of refs) {
    try {
      const record = await canonical(principal, ref, signal);
      if (matches(record, filters)) {
        if (kind === "transcript")
          await authorizeMeetingSearchSource(
            principal,
            ref,
            undefined,
            "transcript",
            signal,
          );
        authorized.push(ref);
      }
    } catch (error) {
      if (error instanceof MeetingSearchError && error.code === "not_available")
        continue;
      throw error;
    }
  }
  return authorized;
}
function transcriptSearchExcerpt(
  passage: Awaited<ReturnType<typeof readTranscriptPassageForUser>>,
  query: string,
) {
  const match = passage.text.toLowerCase().indexOf(query.trim().toLowerCase());
  const start = Math.max(0, match - 150);
  // Display text can expand mentions, so retain the validated stored-source window for locators.
  return { ...passage, text: passage.text.slice(start, start + 600) };
}
async function hydrateSearchCandidate(
  principal: MeetingSearchPrincipal,
  candidate: MeetingSearchCandidate,
  kind: "meeting" | "transcript",
  query: string,
  signal?: AbortSignal,
) {
  try {
    await authorizeMeetingSearchSource(
      principal,
      candidate.meeting,
      candidate.sourceRevision,
      "notes",
      signal,
    );
    if (kind === "meeting")
      return await readMeetingNotesForUser(
        principal,
        { meeting: candidate.meeting },
        signal,
      );
    else if (
      candidate.transcriptHash &&
      candidate.start != null &&
      candidate.end != null &&
      candidate.end > candidate.start
    ) {
      const passageRef = signConsentToken(
        {
          meeting: candidate.meeting,
          revision: candidate.sourceRevision + ":" + candidate.transcriptHash,
          start: Math.max(0, candidate.start - 300),
          end: candidate.end + 300,
          expiresAt: Date.now() + 3600000,
        },
        secret(),
      );
      const passage = await readTranscriptPassageForUser(
        principal,
        { meeting: candidate.meeting, passageRef },
        signal,
      );
      return transcriptSearchExcerpt(passage, query);
    }
  } catch (error) {
    if (
      error instanceof MeetingSearchError &&
      ["not_available", "source_changed"].includes(error.code)
    )
      return;
    throw error;
  }
}
async function consumeSearchCandidates(
  principal: MeetingSearchPrincipal,
  state: Cursor,
  kind: "meeting" | "transcript",
  limit: number,
  hits: (MeetingSearchHit | TranscriptSearchHit)[],
  query: string,
  signal?: AbortSignal,
) {
  const candidates = state.candidates ?? [];
  let index = state.offset;
  for (; index < candidates.length && hits.length < limit; index++) {
    const candidate = candidates[index];
    const hit = await hydrateSearchCandidate(
      principal,
      candidate,
      kind,
      query,
      signal,
    );
    if (hit) hits.push(hit);
  }
  if (index < candidates.length) {
    state.offset = index;
    return true;
  }
  return false;
}
function validateSearch(query: string) {
  if (!config.search.enabled)
    throw new MeetingSearchError(
      "temporarily_unavailable",
      "Meeting search is not enabled.",
      true,
    );
  if (!query.trim())
    throw new MeetingSearchError(
      "invalid_argument",
      "A search query is required.",
    );
}
async function embedQuery(query: string, signal?: AbortSignal) {
  let queryVector: number[] | undefined;
  try {
    queryVector = await embedSearchText(query, signal);
  } catch {
    signal?.throwIfAborted();
  }
  return queryVector;
}
async function prepareSearchPartition(
  principal: MeetingSearchPrincipal,
  state: Cursor,
  refs: MeetingRef[],
  filters: MeetingSearchFilters,
  kind: "meeting" | "transcript",
  query: string,
  queryVector: number[] | undefined,
  signal?: AbortSignal,
) {
  const authorized = await authorizeSearchPartition(
    principal,
    refs,
    filters,
    kind,
    signal,
  );
  if (!authorized.length) {
    state.pending.splice(0, refs.length);
    state.offset = 0;
    state.candidates = undefined;
    state.nextToken = undefined;
    return false;
  }
  if (!state.candidates) {
    const result = await queryMeetingSearchCandidates({
      kind,
      query,
      meetingIds: authorized,
      queryVector,
      signal,
      nextToken: state.nextToken,
    });
    state.candidates = result.candidates;
    state.nextToken = result.nextToken;
    state.windowLimited ||= result.windowLimited;
  }
  return true;
}
function restoreSearchCursor(
  principal: MeetingSearchPrincipal,
  input: MeetingSearchRequest,
  filters: MeetingSearchFilters,
  limit: number,
  kind: "meeting" | "transcript",
) {
  const state = restoreCursor(principal, input, [
    kind,
    input.query,
    filters,
    limit,
  ]);
  if (kind === "transcript" && !input.cursor) {
    state.pending = filters.meetingIds ?? [];
    state.done = true;
  }
  return state;
}
async function nextSearchPartition(
  principal: MeetingSearchPrincipal,
  state: Cursor,
  filters: MeetingSearchFilters,
  kind: "meeting" | "transcript",
  signal?: AbortSignal,
) {
  if (kind === "meeting") await discover(principal, state, filters, signal);
  return state.pending.slice(0, 25);
}
type SearchPage<T> = {
  hits: T[];
  nextCursor: string | null;
  coverage: SearchCoverage;
};
function search(
  principal: MeetingSearchPrincipal,
  input: MeetingSearchRequest,
  kind: "meeting",
  signal?: AbortSignal,
): Promise<SearchPage<MeetingSearchHit>>;
function search(
  principal: MeetingSearchPrincipal,
  input: MeetingSearchRequest,
  kind: "transcript",
  signal?: AbortSignal,
): Promise<SearchPage<TranscriptSearchHit>>;
async function search(
  principal: MeetingSearchPrincipal,
  input: MeetingSearchRequest,
  kind: "meeting" | "transcript",
  signal?: AbortSignal,
) {
  validateSearch(input.query);
  const filters = parseFilters(input.filters);
  const limit = pageLimit(input.pageSize);
  const state = restoreSearchCursor(principal, input, filters, limit, kind);
  const queryVector = await embedQuery(input.query, signal);
  const hits: (MeetingSearchHit | TranscriptSearchHit)[] = [];
  const deadline = Date.now() + 10000;
  while (hits.length < limit && Date.now() < deadline) {
    const refs = await nextSearchPartition(
      principal,
      state,
      filters,
      kind,
      signal,
    );
    if (!refs.length) {
      if (state.done) break;
      continue;
    }
    if (
      !(await prepareSearchPartition(
        principal,
        state,
        refs,
        filters,
        kind,
        input.query,
        queryVector,
        signal,
      ))
    )
      continue;
    if (
      await consumeSearchCandidates(
        principal,
        state,
        kind,
        limit,
        hits,
        input.query,
        signal,
      )
    )
      break;
    state.candidates = undefined;
    state.offset = 0;
    if (!state.nextToken) state.pending.splice(0, refs.length);
  }
  const coverage: SearchCoverage = {
    status: "partial",
    semanticStatus: queryVector ? "partial" : "unavailable",
    ranking: "authorized_partition_order",
    windowLimited: state.windowLimited ?? false,
  };
  return {
    hits,
    nextCursor: nextSearchCursor(state),
    coverage,
  };
}
export function searchMeetingsForUser(
  principal: MeetingSearchPrincipal,
  input: MeetingSearchRequest,
  signal?: AbortSignal,
) {
  return search(principal, input, "meeting", signal);
}
export function searchTranscriptsForUser(
  principal: MeetingSearchPrincipal,
  input: TranscriptSearchRequest,
  signal?: AbortSignal,
) {
  if (!input.meetingIds.length)
    return Promise.reject(
      new MeetingSearchError(
        "invalid_argument",
        "Select at least one meeting.",
      ),
    );
  return search(
    principal,
    { ...input, filters: { meetingIds: input.meetingIds, archive: "all" } },
    "transcript",
    signal,
  );
}
