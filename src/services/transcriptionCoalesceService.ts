import type { MeetingData } from "../types/meeting-data";
import type { TranscriptVariant } from "../types/audio";
import { getTranscriptionCoalescePrompt } from "./transcriptionPromptService";
import { getModelChoice } from "./modelFactory";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { chat } from "./openaiChatService";

type CoalesceInput = {
  slowTranscript: string;
  fastTranscripts: TranscriptVariant[];
};

export async function coalesceTranscription(
  meeting: MeetingData,
  input: CoalesceInput,
): Promise<string> {
  const { messages, langfusePrompt } = await getTranscriptionCoalescePrompt(
    meeting,
    input,
  );
  const modelChoice = getModelChoice(
    "transcriptionCoalesce",
    getMeetingModelOverrides(meeting),
  );
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: modelChoice.model,
      traceName: "transcription-coalesce",
      generationName: "transcription-coalesce",
      tags: ["feature:transcription_coalesce"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "transcriptionCoalesce",
    },
  );
}
