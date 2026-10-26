import type { MeetingData } from "../types/meeting-data";
import { buildMeetingContext, formatContextForPrompt } from "./contextService";
import { getLangfuseChatPrompt } from "./langfusePromptService";
import { chat } from "./openaiChatService";
import { getModelChoice } from "./modelFactory";
import { createOpenAIClient } from "./openaiClient";
import { config } from "./configService";
import { getMeetingModelOverrides } from "./meetingModelOverrides";

export async function getImage(
  meeting: MeetingData,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const contextData = await buildMeetingContext(meeting, false);
  signal?.throwIfAborted();
  const formattedContext = formatContextForPrompt(contextData, "image");
  const briefContext = formattedContext
    ? formattedContext.substring(0, 500)
    : "";
  const briefContextBlock = briefContext ? `Context: ${briefContext}. ` : "";
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.imagePromptName,
    variables: {
      briefContextBlock,
      transcript: meeting.finalTranscript ?? "",
    },
  });

  signal?.throwIfAborted();
  const imagePromptModel = getModelChoice(
    "imagePrompt",
    getMeetingModelOverrides(meeting),
  );
  const imagePrompt = await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      signal,
      model: imagePromptModel.model,
      traceName: "image-prompt",
      generationName: "image-prompt",
      tags: ["feature:image_prompt"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "imagePrompt",
    },
  );

  signal?.throwIfAborted();
  const imageModel = getModelChoice("image", getMeetingModelOverrides(meeting));
  const imageClient = createOpenAIClient({
    traceName: "image",
    generationName: "image",
    userId: meeting.creator.id,
    sessionId: meeting.meetingId,
    tags: ["feature:image"],
    metadata: {
      guildId: meeting.guild.id,
      channelId: meeting.voiceChannel.id,
    },
    parentSpanContext: meeting.langfuseParentSpanContext,
  });
  const response = await imageClient.images.generate(
    {
      model: imageModel.model,
      size: "1024x1024",
      quality: "hd",
      n: 1,
      prompt: imagePrompt,
    },
    signal ? { signal } : undefined,
  );
  signal?.throwIfAborted();

  const output = response.data?.[0]?.url;

  return output || "";
}
