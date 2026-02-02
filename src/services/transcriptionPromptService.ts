import type { MeetingData } from "../types/meeting-data";
import type { TranscriptVariant } from "../types/audio";
import { buildMeetingContext, formatContextForPrompt } from "./contextService";
import { config } from "./configService";
import {
  getLangfuseChatPrompt,
  getLangfuseTextPrompt,
  type TextPromptResult,
} from "./langfusePromptService";
import { getBotNameVariants } from "../utils/botNames";
import {
  buildDictionaryPromptLines,
  DEFAULT_DICTIONARY_BUDGETS,
} from "../utils/dictionary";
import { resolveMeetingAttendees } from "../utils/meetingAttendees";

type TranscriptionPromptVariables = {
  serverName: string;
  channelName: string;
  serverDescriptionLine: string;
  attendeesLine: string;
  botNamesLine: string;
  dictionaryBlock: string;
  meetingContextLine: string;
};

const buildTranscriptionPromptVariables = (
  meeting: MeetingData,
): TranscriptionPromptVariables => {
  const serverName = meeting.voiceChannel.guild.name;
  const channelName = meeting.voiceChannel.name;
  const serverDescription = meeting.guild.description || "";
  const attendees = resolveMeetingAttendees(meeting).join(", ");

  const botNames = getBotNameVariants(
    meeting.guild.members.me,
    meeting.guild.client.user,
  );

  const budgets =
    meeting.runtimeConfig?.dictionary ?? DEFAULT_DICTIONARY_BUDGETS;
  const { transcriptionLines } = buildDictionaryPromptLines(
    meeting.dictionaryEntries ?? [],
    budgets,
  );

  const serverDescriptionLine = serverDescription
    ? `Server Description: ${serverDescription}`
    : "";
  const attendeesLine = `Attendees: ${attendees}`;
  const botNamesLine =
    botNames.length > 0 ? `Bot Names: ${botNames.join(", ")}` : "";
  const dictionaryBlock =
    transcriptionLines.length > 0
      ? `Dictionary terms:\n${transcriptionLines.join("\n")}`
      : "";
  const meetingContextLine = meeting.meetingContext
    ? `Meeting Context: ${meeting.meetingContext}`
    : "";

  return {
    serverName,
    channelName,
    serverDescriptionLine,
    attendeesLine,
    botNamesLine,
    dictionaryBlock,
    meetingContextLine,
  };
};

const buildFallbackTranscriptionPrompt = (
  variables: TranscriptionPromptVariables,
): TextPromptResult => {
  const lines = [
    "<glossary>(do not include in transcript):",
    `Server Name: ${variables.serverName}`,
    `Channel: ${variables.channelName}`,
    variables.serverDescriptionLine,
    variables.attendeesLine,
    variables.botNamesLine,
    variables.dictionaryBlock,
    variables.meetingContextLine,
    "Transcript instruction: Do not include any glossary text in the transcript.",
    "</glossary>",
  ].filter((line) => line !== "");

  return {
    prompt: lines.join("\n"),
    langfusePrompt: {
      name: config.langfuse.transcriptionPromptName,
      version: 0,
      isFallback: true,
    },
    source: "fallback",
  };
};

export async function getTranscriptionPrompt(meeting: MeetingData) {
  const variables = buildTranscriptionPromptVariables(meeting);

  try {
    return await getLangfuseTextPrompt({
      name: config.langfuse.transcriptionPromptName,
      variables,
    });
  } catch (error) {
    console.warn(
      "Langfuse transcription prompt unavailable, using fallback.",
      error,
    );
    return buildFallbackTranscriptionPrompt(variables);
  }
}

export async function getTranscriptionCleanupPrompt(
  meeting: MeetingData,
  transcription: string,
) {
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "transcription");

  const serverName = meeting.guild.name;
  const serverDescription = meeting.guild.description ?? "";
  const roles = meeting.guild.roles
    .valueOf()
    .map((role) => role.name)
    .join(", ");
  const events = meeting.guild.scheduledEvents
    .valueOf()
    .map((event) => event.name)
    .join(", ");
  const channelNames = meeting.guild.channels
    .valueOf()
    .map((channel) => channel.name)
    .join(", ");

  return await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCleanupPromptName,
    variables: {
      formattedContext,
      attendees: resolveMeetingAttendees(meeting).join(", "),
      serverName,
      serverDescription,
      voiceChannelName: meeting.voiceChannel.name,
      roles,
      events,
      channelNames,
      transcription,
    },
  });
}

type CoalesceInput = {
  slowTranscript: string;
  fastTranscripts: TranscriptVariant[];
};

export async function getTranscriptionCoalescePrompt(
  meeting: MeetingData,
  input: CoalesceInput,
) {
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "transcription");
  const fastTranscriptBlock = input.fastTranscripts
    .map((entry) => `- (rev ${entry.revision}) ${entry.text}`)
    .join("\n");

  return await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCoalescePromptName,
    variables: {
      formattedContext,
      serverName: meeting.guild.name,
      voiceChannelName: meeting.voiceChannel.name,
      attendees: resolveMeetingAttendees(meeting).join(", "),
      slowTranscript: input.slowTranscript,
      fastTranscriptBlock,
    },
  });
}
