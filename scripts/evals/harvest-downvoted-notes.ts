import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { listFeedbackEntries } from "../../src/services/adminFeedbackService";
import { listGuildRolesCached } from "../../src/services/discordCacheService";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import {
  formatParticipantRoster,
  formatRoleRoster,
  isMentionableRole,
} from "../../src/services/notesPromptService";
import { fetchJsonFromS3 } from "../../src/services/storageService";
import type { MeetingHistory } from "../../src/types/db";
import type { TranscriptPayload } from "../../src/types/transcript";
import { isPersonalMeeting } from "../../src/utils/meetingOwnership";

const DEFAULT_LIMIT = 25;

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const resolveMentionableRolesForGuild = async (meeting: MeetingHistory) => {
  if (isPersonalMeeting(meeting)) return [];
  const roles = await listGuildRolesCached(meeting.guildId);
  return roles
    .filter((role) => isMentionableRole(role, meeting.guildId))
    .map((role) => ({ id: role.id, name: role.name }));
};

const buildEvalCase = async (meeting: MeetingHistory, comment?: string) => {
  const participants = meeting.participants ?? [];
  const mentionableRoles = await resolveMentionableRolesForGuild(meeting);
  const transcriptPayload = meeting.transcriptS3Key
    ? await fetchJsonFromS3<TranscriptPayload>(meeting.transcriptS3Key)
    : undefined;

  return {
    input: {
      transcript: transcriptPayload?.text ?? "",
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
      allowedRoleIds: mentionableRoles.map((role) => role.id),
      guildId: isPersonalMeeting(meeting) ? undefined : meeting.guildId,
    },
    // Left blank on purpose. A human decides what good output looks like before
    // a harvested case is worth anything as an eval.
    expectedOutput: {},
    metadata: {
      meetingId: meeting.meetingId,
      notesVersion: meeting.notesVersion,
      downvoteComment: comment,
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
  const limit = Number(parseFlagValue("--limit") ?? DEFAULT_LIMIT);

  const { items } = await listFeedbackEntries({
    targetType: "meeting_summary",
    rating: "down",
    limit,
  });
  console.log(`Found ${items.length} downvoted meeting summaries.`);

  const cases = [];
  for (const item of items) {
    const meeting = await getMeetingHistoryService(item.guildId, item.targetId);
    if (!meeting) {
      console.warn(`Skipping ${item.targetId}: meeting history not found.`);
      continue;
    }
    cases.push(await buildEvalCase(meeting, item.comment));
  }

  await mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await writeFile(
    path.resolve(output),
    `${JSON.stringify(cases, null, 2)}\n`,
    "utf8",
  );
  console.log(`Wrote ${cases.length} eval case stub(s) to ${output}`);
  console.log(
    "These stubs contain real user content. Fill in expectedOutput, strip anything identifying, then upload to Langfuse. Do not commit them.",
  );
}

main().catch((error) => {
  console.error("Harvest failed:", error);
  process.exit(1);
});
