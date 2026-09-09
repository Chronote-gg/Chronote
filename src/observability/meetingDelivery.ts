import { DiscordAPIError } from "discord.js";
import { updateActiveObservation } from "@langfuse/tracing";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";
import type { MeetingData } from "../types/meeting-data";
import type { DeliveryPhase, DeliveryResult } from "../types/meetingDelivery";

// Never serialize Discord errors: they contain request bodies and message content.
export function deliveryError(
  error: unknown,
): DeliveryResult["errors"][number] {
  return error instanceof DiscordAPIError
    ? {
        code: typeof error.code === "number" ? error.code : undefined,
        status: error.status,
      }
    : {};
}

export function recordDelivery(
  meeting: MeetingData,
  phase: DeliveryPhase,
  result: DeliveryResult,
): DeliveryResult {
  meeting.delivery = { ...meeting.delivery, [phase]: result };
  const evidence = {
    meetingId: meeting.meetingId,
    guildId: meeting.guildId,
    phase,
    ...result,
  };
  const degraded = result.outcome === "failed" || result.outcome === "partial";
  if (degraded) console.warn("Meeting delivery degraded", evidence);
  else console.log("Meeting delivery completed", evidence);
  // Observability must never prevent delivery, history persistence or cleanup.
  try {
    if (isLangfuseTracingEnabled()) {
      updateActiveObservation(
        {
          metadata: { delivery: meeting.delivery },
          ...(degraded
            ? {
                level: "ERROR" as const,
                statusMessage: "Discord delivery degraded",
              }
            : {}),
        },
        { asType: "chain" },
      );
    }
  } catch {
    console.warn("Meeting delivery telemetry unavailable", {
      meetingId: meeting.meetingId,
      phase,
    });
  }
  return result;
}
