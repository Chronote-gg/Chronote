import type { MeetingData } from "../types/meeting-data";
import { chat } from "./openaiChatService";
import { getNotesPrompt } from "./notesPromptService";

export async function getNotes(meeting: MeetingData): Promise<string> {
  const { messages, langfusePrompt } = await getNotesPrompt(meeting);
  return await chat(
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
}
