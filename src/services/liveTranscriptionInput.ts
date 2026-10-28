import type { MeetingData } from "../types/meeting-data";
import type { TranscriptionContentInput } from "./transcriptionService";
import type { FinalPassContent } from "./transcriptionFinalPassService";
import {
  fixtureGenerationObserver,
  fixtureParticipants,
} from "./fixtureInputService";
import {
  getMeetingProcessingSignal,
  runMeetingProcessingEffect,
} from "./meetingProcessingLifetime";
import {
  getTranscriptionPrompt,
  getTranscriptionFinalPassPrompt,
} from "./transcriptionPromptService";
import { getModelChoice } from "./modelFactory";
import { getMeetingModelOverrides } from "./meetingModelOverrides";
import { liveFinalPassSettings } from "./transcriptionProcessingSettings";
import { resolveChatParamsForRole } from "./openaiModelParams";
import { meetingTranscriptionLanguage } from "../config/transcriptionLanguage";

export function liveTranscriptionInput(
  meeting: MeetingData,
): TranscriptionContentInput {
  return {
    meetingId: meeting.meetingId,
    creator: { id: meeting.creator.id },
    guild: { id: meeting.guild.id },
    voiceChannel: { id: meeting.voiceChannel.id },
    signal: getMeetingProcessingSignal(meeting),
    runtimeConfig: meeting.runtimeConfig,
    observeGeneration: fixtureGenerationObserver(meeting),
    prompt: () => getTranscriptionPrompt(meeting),
    effect: (run) => runMeetingProcessingEffect(meeting, run),
  };
}

export function liveFinalPassInput(meeting: MeetingData): FinalPassContent {
  const choice = getModelChoice(
    "transcriptionCoalesce",
    getMeetingModelOverrides(meeting),
  );
  return {
    observeGeneration: fixtureGenerationObserver(meeting),
    meetingId: meeting.meetingId,
    creator: { id: meeting.creator.id },
    guild: { id: meeting.guild.id },
    voiceChannel: { id: meeting.voiceChannel.id },
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    participants: fixtureParticipants(meeting)
      ? new Map(fixtureParticipants(meeting)!.map((p) => [p.id, p]))
      : meeting.participants,
    audioData: { audioFiles: meeting.audioData.audioFiles },
    langfuseParentSpanContext: meeting.langfuseParentSpanContext,
    enabled: meeting.runtimeConfig?.transcription.finalPassEnabled ?? true,
    settings: liveFinalPassSettings,
    signal: getMeetingProcessingSignal(meeting),
    transcriptionModel: getModelChoice(
      "transcription",
      getMeetingModelOverrides(meeting),
    ).model,
    transcriptionLanguage: meetingTranscriptionLanguage(meeting.runtimeConfig),
    reconcileModel: {
      ...choice,
      params: resolveChatParamsForRole({
        role: "transcriptionCoalesce",
        model: choice.model,
        config: meeting.runtimeConfig?.modelParams?.transcriptionCoalesce,
      }),
    },
    prompt: () => getTranscriptionPrompt(meeting),
    finalPassPrompt: (input) => getTranscriptionFinalPassPrompt(meeting, input),
    effect: (run) => runMeetingProcessingEffect(meeting, run),
  };
}
