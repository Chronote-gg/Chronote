import type { MeetingData } from "../types/meeting-data";
import type { SavedRecordingSettings } from "../types/recordingContent";
import { getTranscriptionCleanupPrompt } from "./transcriptionPromptService";
import { getModelChoice } from "./modelFactory";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { chat, type ChatMeetingInput } from "./openaiChatService";

export type PreparedTranscriptionCleanup = {
  transcription: string;
  prompt: Pick<
    Awaited<ReturnType<typeof getTranscriptionCleanupPrompt>>,
    "messages" | "langfusePrompt"
  >;
  model: SavedRecordingSettings["models"]["transcriptionCleanup"];
};

export async function prepareTranscriptionCleanup(
  meeting: MeetingData,
  transcription: string,
): Promise<PreparedTranscriptionCleanup> {
  const { messages, langfusePrompt } = await getTranscriptionCleanupPrompt(
    meeting,
    transcription,
  );
  const modelChoice = getModelChoice(
    "transcriptionCleanup",
    getMeetingModelOverrides(meeting),
  );
  return {
    transcription,
    prompt: { messages, langfusePrompt },
    model: {
      ...modelChoice,
      params: resolveChatParamsForRole({
        role: "transcriptionCleanup",
        model: modelChoice.model,
        config: meeting.runtimeConfig?.modelParams?.transcriptionCleanup,
      }),
    },
  };
}
export async function cleanupContentTranscription(
  content: ChatMeetingInput,
  prompt: Pick<
    Awaited<ReturnType<typeof getTranscriptionCleanupPrompt>>,
    "messages" | "langfusePrompt"
  >,
  model: SavedRecordingSettings["models"]["transcriptionCleanup"],
  parentSpanContext?: MeetingData["langfuseParentSpanContext"],
) {
  return chat(
    content,
    { messages: [...prompt.messages] },
    {
      model: model.model,
      frozenModel: model,
      traceName: "transcription-cleanup",
      generationName: "transcription-cleanup",
      tags: ["feature:transcription_cleanup"],
      langfusePrompt: prompt.langfusePrompt,
      parentSpanContext,
      modelParamRole: "transcriptionCleanup",
    },
  );
}
export function retainCleanupTranscript(
  original: string,
  cleaned: string,
  minimumLineRatio: number,
) {
  return (cleaned || "").split("\n").length <
    original.split("\n").length * minimumLineRatio
    ? original
    : cleaned;
}
