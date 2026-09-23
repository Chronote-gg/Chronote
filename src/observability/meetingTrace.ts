import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import type { MeetingData } from "../types/meeting-data";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";
import { toLangfuseAttributeMetadata } from "./langfuseMetadata";
import { getAudioTranscriptionFacts } from "../utils/audioTranscript";

function getStageOutcome(meeting: MeetingData, name: string) {
  if (name === "generate-notes") return meeting.processing?.notes;
  if (name === "generate-summary") return meeting.processing?.summary;
  return undefined;
}

export async function withMeetingEndTrace(
  meeting: MeetingData,
  run: () => Promise<void>,
): Promise<void> {
  if (!isLangfuseTracingEnabled()) {
    await run();
    return;
  }

  const traceMetadata = {
    guildId: meeting.guildId,
    channelId: meeting.channelId,
    meetingId: meeting.meetingId,
    isAutoRecording: meeting.isAutoRecording,
    transcribeMeeting: meeting.transcribeMeeting,
    generateNotes: meeting.generateNotes,
  };
  const traceInput = {
    startedAt: meeting.startTime.toISOString(),
    voiceChannelId: meeting.voiceChannel.id,
    voiceChannelName: meeting.voiceChannel.name,
  };

  await propagateAttributes(
    {
      traceName: "meeting-end",
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: ["feature:meeting_end"],
      metadata: toLangfuseAttributeMetadata(traceMetadata),
    },
    async () =>
      startActiveObservation(
        "meeting-end",
        async (chain) => {
          const previousContext = meeting.langfuseParentSpanContext;
          meeting.langfuseParentSpanContext = chain.otelSpan.spanContext();

          setActiveTraceIO({ input: traceInput });
          updateActiveObservation(
            {
              input: traceInput,
              metadata: traceMetadata,
            },
            { asType: "chain" },
          );

          let finalizationFailed = false;
          try {
            await run();
          } catch (error) {
            finalizationFailed = true;
            updateActiveObservation(
              {
                level: "ERROR",
                statusMessage: error ? String(error) : "meeting end failed",
              },
              { asType: "chain" },
            );
            throw error;
          } finally {
            const deliveryDegraded = Object.values(meeting.delivery ?? {}).some(
              (result) =>
                result.outcome === "failed" || result.outcome === "partial",
            );
            const facts = meeting.audioData
              ? getAudioTranscriptionFacts(meeting.audioData)
              : {
                  usableSegments: 0,
                  failedSegments: 0,
                  captureIncomplete: false,
                };
            const processingFailed =
              meeting.processing?.transcription === "failed" ||
              meeting.processing?.notes === "failed" ||
              meeting.processing?.summary === "failed";
            const processingPartial =
              meeting.processing?.transcription === "partial";
            updateActiveObservation(
              {
                metadata: {
                  delivery: meeting.delivery,
                  processing: meeting.processing,
                  ...facts,
                },
                ...((deliveryDegraded || processingFailed) &&
                !finalizationFailed
                  ? {
                      level: "ERROR" as const,
                      statusMessage: deliveryDegraded
                        ? "Discord delivery degraded"
                        : "Meeting processing failed",
                    }
                  : processingPartial && !finalizationFailed
                    ? {
                        level: "WARNING" as const,
                        statusMessage: "Meeting transcription partial",
                      }
                    : {}),
                output: {
                  finishedAt: meeting.endTime?.toISOString(),
                  transcriptLength: meeting.finalTranscript?.length ?? 0,
                  notesLength: meeting.notesText?.length ?? 0,
                  summarySentence: meeting.summarySentence,
                  summaryLabel: meeting.summaryLabel,
                },
              },
              { asType: "chain" },
            );
            meeting.langfuseParentSpanContext = previousContext;
          }
        },
        { asType: "chain" },
      ),
  );
}

export type MeetingEndStepOptions = {
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export async function withMeetingEndStep<T>(
  meeting: MeetingData,
  name: string,
  run: () => Promise<T>,
  options: MeetingEndStepOptions = {},
): Promise<T> {
  if (!isLangfuseTracingEnabled()) {
    return await run();
  }

  return await startActiveObservation(
    name,
    async () => {
      if (options.input || options.metadata) {
        updateActiveObservation(
          {
            input: options.input,
            metadata: options.metadata,
          },
          { asType: "chain" },
        );
      }

      const startedAt = Date.now();
      try {
        const result = await run();
        const stageOutcome = getStageOutcome(meeting, name);
        if (stageOutcome) {
          updateActiveObservation(
            {
              metadata: { stageOutcome },
              ...(stageOutcome === "failed"
                ? { level: "ERROR" as const }
                : { level: "DEFAULT" as const }),
            },
            { asType: "chain" },
          );
        }
        return result;
      } catch (error) {
        updateActiveObservation(
          {
            level: "ERROR",
            statusMessage: error ? String(error) : `${name} failed`,
          },
          { asType: "chain" },
        );
        throw error;
      } finally {
        updateActiveObservation(
          {
            output: {
              durationMs: Date.now() - startedAt,
            },
          },
          { asType: "chain" },
        );
      }
    },
    { asType: "chain" },
  );
}
