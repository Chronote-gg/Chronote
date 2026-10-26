import { Stack, Text } from "@mantine/core";
import type {
  MeetingUpdatePublicDelivery,
  MeetingUpdatePublicReason,
} from "../../../../services/meetingUpdateStatus";

const explanations: Record<MeetingUpdatePublicReason, string> = {
  explicit_hold: "New edits stay saved while publication is on hold.",
  inaccessible_destination:
    "The Discord destination is unavailable. An authorized person needs to check access.",
  initial_publication_unsettled:
    "Initial publication still needs to be confirmed.",
  legacy_publication_unknown:
    "Earlier publication needs to be verified before updates can continue.",
  missing_target:
    "A recorded Discord post is missing. Chronote will not recreate it automatically.",
  not_submitted: "Discord has not accepted this update yet.",
  provider_outcome_unknown:
    "The previous Discord result cannot be confirmed. New edits remain saved while it is checked.",
  provider_rejected: "Discord rejected the update.",
  rate_limited:
    "Discord asked Chronote to wait. The update will be checked again.",
  repair_publication_unsettled: "A publication repair still needs to finish.",
  retry_exhausted:
    "Automatic retries have stopped after repeated known failures. Your edits remain saved.",
  stored_only: "This meeting was saved without permission to publish updates.",
  unsupported_layout:
    "The recorded Discord layout needs review before it can be updated.",
};
export function meetingUpdateSaveCopy(
  delivery: MeetingUpdatePublicDelivery,
): string {
  switch (delivery.status) {
    case "pending":
      return "Saved. Updating Discord.";
    case "synced":
      return "Saved. Discord is up to date.";
    case "held":
      return "Saved. Publication is on hold.";
    case "blocked":
    case "uncertain":
      return "Saved. Discord update needs attention.";
    case "unpublished":
      return "Saved.";
  }
}
export function MeetingUpdateDeliveryStatus({
  delivery,
}: {
  delivery: MeetingUpdatePublicDelivery;
}) {
  return (
    <Stack
      gap={2}
      role="status"
      aria-live="polite"
      data-testid="meeting-update-delivery"
      py="xs"
    >
      <Text
        size="sm"
        fw={600}
        c={
          delivery.status === "blocked" || delivery.status === "uncertain"
            ? "yellow"
            : undefined
        }
      >
        {meetingUpdateSaveCopy(delivery)}
      </Text>
      {delivery.reason ? (
        <Text size="xs" c="dimmed">
          {explanations[delivery.reason]}
        </Text>
      ) : null}
      {delivery.status === "unpublished" ? (
        <Text size="xs" c="dimmed">
          No Discord publication is configured for this meeting.
        </Text>
      ) : null}

      <details>
        <summary style={{ cursor: "pointer" }}>
          <Text component="span" size="xs" c="dimmed">
            Revision {delivery.desiredRevision}
            {delivery.syncedRevision !== null
              ? ` · Discord revision ${delivery.syncedRevision}`
              : ""}{" "}
            · Delivery details
          </Text>
        </summary>
        <Text size="xs" c="dimmed">
          {delivery.lastSuccess
            ? `Last verified captured update: revision ${delivery.lastSuccess.contentRevision}, ${new Date(delivery.lastSuccess.at * 1000).toLocaleString()}`
            : "No verified captured Discord update is recorded."}
        </Text>
      </details>
    </Stack>
  );
}
