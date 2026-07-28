import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listFeedbackEntries } from "../../src/services/adminFeedbackService";
import { listGuildRolesCached } from "../../src/services/discordCacheService";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import {
  formatParticipantRoster,
  formatRoleRoster,
  isMentionableRole,
  selectRolesForPrompt,
} from "../../src/services/notesPromptService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import type { MeetingHistory } from "../../src/types/db";
import type { TranscriptPayload } from "../../src/types/transcript";
import { isPersonalMeeting } from "../../src/utils/meetingOwnership";

const DEFAULT_LIMIT = 25;
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const IGNORED_OUTPUT_SUFFIX = ".harvested.json";

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return undefined;
  }
  return process.argv[index + 1];
}

/**
 * Refuses to write real meeting content into a trackable path in this public
 * repo. Checked before any data is fetched, so a bad path fails fast rather
 * than after the sensitive file already exists.
 */
const resolveSafeOutputPath = (output: string): string => {
  const resolved = path.resolve(output);
  const relativeToRepo = path.relative(REPO_ROOT, resolved);
  const insideRepo =
    !relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo);
  if (insideRepo && !resolved.endsWith(IGNORED_OUTPUT_SUFFIX)) {
    throw new Error(
      `Refusing to write harvested cases to ${resolved}. This repository is public and harvested cases contain real meeting content. Write outside the repo, or use a filename ending in ${IGNORED_OUTPUT_SUFFIX} which is gitignored.`,
    );
  }
  return resolved;
};

const resolveMentionableRolesForGuild = async (meeting: MeetingHistory) => {
  if (isPersonalMeeting(meeting)) return [];
  const roles = await listGuildRolesCached(meeting.guildId);
  return roles
    .filter((role) => isMentionableRole(role, meeting.guildId))
    .map((role) => ({ id: role.id, name: role.name }));
};

const buildEvalCase = async (meeting: MeetingHistory, comments: string[]) => {
  const participants = meeting.participants ?? [];
  const mentionableRoles = await resolveMentionableRolesForGuild(meeting);
  // Only the roles the prompt actually renders count as allowed, otherwise an
  // id from the dropped tail would silently pass the hallucination grade.
  const promptRoles = selectRolesForPrompt(mentionableRoles, participants);
  const transcriptPayload = meeting.transcriptS3Key
    ? await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key)
    : undefined;

  return {
    input: {
      // Rows predating S3 transcript storage still carry the deprecated
      // inline transcript, same fallback the MCP transcript path uses.
      transcript: transcriptPayload?.text ?? meeting.transcript ?? "",
      participantRoster:
        formatParticipantRoster(
          participants,
          new Map(mentionableRoles.map((role) => [role.id, role.name])),
        ) ?? "No participant roster captured.",
      roles: formatRoleRoster(mentionableRoles, participants),
      attendees: participants
        .map((participant) => participant.username)
        .join(", "),
      allowedUserIds: participants.map((participant) => participant.id),
      allowedRoleIds: promptRoles.map((role) => role.id),
      guildId: isPersonalMeeting(meeting) ? undefined : meeting.guildId,
    },
    // Left blank on purpose. A human decides what good output looks like before
    // a harvested case is worth anything as an eval.
    expectedOutput: {},
    metadata: {
      meetingId: meeting.meetingId,
      notesVersion: meeting.notesVersion,
      downvoteComments: comments,
      generatedNotes: meeting.notes,
    },
  };
};

async function main() {
  const output = parseFlagValue("--output");
  if (!output) {
    throw new Error(
      "--output <path> is required. Harvested cases contain real meeting content, so write them outside this public repo (for example a private ops repo or a Langfuse upload staging file).",
    );
  }
  const resolvedOutput = resolveSafeOutputPath(output);
  const limit = Number(parseFlagValue("--limit") ?? DEFAULT_LIMIT);

  // Feedback is keyed per user, so one meeting appears once per downvoter.
  // --limit counts distinct meetings, so keep paging until that many are
  // collected rather than deduplicating a single page down to fewer.
  const commentsByMeeting = new Map<
    string,
    { guildId: string; targetId: string; comments: string[] }
  >();
  let cursor: string | undefined;
  let recordCount = 0;
  do {
    const page = await listFeedbackEntries({
      targetType: "meeting_summary",
      rating: "down",
      limit,
      cursor,
    });
    recordCount += page.items.length;
    for (const item of page.items) {
      const key = `${item.guildId}#${item.targetId}`;
      const entry = commentsByMeeting.get(key) ?? {
        guildId: item.guildId,
        targetId: item.targetId,
        comments: [],
      };
      if (item.comment) entry.comments.push(item.comment);
      commentsByMeeting.set(key, entry);
    }
    cursor = page.nextCursor;
  } while (cursor && commentsByMeeting.size < limit);

  const selected = Array.from(commentsByMeeting.values()).slice(0, limit);
  console.log(
    `Read ${recordCount} downvote record(s), ${commentsByMeeting.size} distinct meeting(s), harvesting ${selected.length}.`,
  );

  const cases = [];
  for (const entry of selected) {
    const meeting = await getMeetingHistoryService(
      entry.guildId,
      entry.targetId,
    );
    if (!meeting) {
      console.warn(`Skipping ${entry.targetId}: meeting history not found.`);
      continue;
    }
    cases.push(await buildEvalCase(meeting, entry.comments));
  }

  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(
    resolvedOutput,
    `${JSON.stringify(cases, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${cases.length} eval case stub(s) to ${resolvedOutput}`);
  console.log(
    "These stubs contain real user content. Fill in expectedOutput, strip anything identifying, then upload to Langfuse. Do not commit them.",
  );
}

main().catch((error) => {
  console.error("Harvest failed:", error);
  process.exit(1);
});
