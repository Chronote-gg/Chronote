import type { MeetingData } from "../types/meeting-data";
import { stripUnknownMentions } from "../utils/mentionSanitizer";
import { chat } from "./openaiChatService";
import {
  getNotesPrompt,
  resolvePromptVisibleRoleIds,
} from "./notesPromptService";

export async function getNotes(meeting: MeetingData): Promise<string> {
  const { messages, langfusePrompt } = await getNotesPrompt(meeting);
  const notes = await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      traceName: "notes",
      generationName: "notes",
      tags: ["feature:notes"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "notes",
    },
  );

  // The prompt forbids inventing mention ids, but notes are persisted and
  // posted verbatim, so the rosters are enforced rather than assumed.
  return stripUnknownMentions(notes, {
    userIds: Array.from(meeting.participants.keys()),
    roleIds: resolvePromptVisibleRoleIds(meeting),
  });
}
