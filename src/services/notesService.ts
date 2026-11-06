import { startObservation } from "@langfuse/tracing";
import { isLangfuseTracingEnabled } from "./langfuseClient";
import type { MeetingNotesInput } from "../types/meeting-data";
import { stripUnknownMentions } from "../utils/mentionSanitizer";
import { chat } from "./openaiChatService";
import { getNotesPrompt } from "./notesPromptService";

export async function getNotes(meeting: MeetingNotesInput): Promise<string> {
  const { messages, langfusePrompt, promptVisibleRoleIds } =
    await getNotesPrompt(meeting);
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
  // posted verbatim, so the rosters are enforced rather than assumed. Both
  // lists are the ones the prompt was built from, captured before the call.
  const sanitizedNotes = stripUnknownMentions(notes, {
    userIds: Array.from(meeting.participants.keys()),
    roleIds: promptVisibleRoleIds,
  });
  try {
    if (isLangfuseTracingEnabled() && sanitizedNotes.trim())
      startObservation(
        "notes-final-artifact",
        { input: messages, output: sanitizedNotes },
        { parentSpanContext: meeting.langfuseParentSpanContext },
      ).end();
  } catch {
    console.warn("Final notes telemetry unavailable");
  }
  return sanitizedNotes;
}
