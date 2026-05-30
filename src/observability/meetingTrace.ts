import {
  propagateAttributes,
  setActiveTraceIO,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import type { MeetingData } from "../types/meeting-data";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";
import { toLangfuseAttributeMetadata } from "./langfuseMetadata";

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

          try {
            await run();
          } catch (error) {
            updateActiveObservation(
              {
                level: "ERROR",
                statusMessage: error ? String(error) : "meeting end failed",
              },
              { asType: "chain" },
            );
            throw error;
          } finally {
            updateActiveObservation(
              {
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
        return await run();
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
