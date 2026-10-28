import { useState } from "react";
import {
  Button,
  Checkbox,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from "@mantine/core";
import type { MeetingProcessingOutcome } from "../../../../types/meetingProcessing";
import type {
  ProcessingRetryFailureReason,
  ProcessingRetryIneligibleReason,
  ProcessingRetryView,
} from "../../../../types/meetingProcessingRetry";
import { getMeetingProcessingNotice } from "../../../../utils/meetingProcessing";

export type MeetingProcessingRetryProps = {
  view: ProcessingRetryView;
  pending: boolean;
  onRetry(replaceNotes: boolean): void;
};

type Props = MeetingProcessingRetryProps & {
  processing?: MeetingProcessingOutcome;
  notes: string;
};

const SOURCE_MISSING_COPY =
  "The recording needed for a retry is no longer available.";

const FAILURE_COPY: Record<ProcessingRetryFailureReason, string> = {
  stage_failed: "The retry could not finish. Nothing was changed.",
  notes_changed: "The notes changed while the retry ran, so nothing was saved.",
  source_missing: SOURCE_MISSING_COPY,
  invalid_snapshot:
    "The saved recording could not be read, so nothing was saved.",
  nothing_to_retry:
    "Nothing left to retry: the missing parts were never recorded.",
  unknown: "The retry stopped unexpectedly. Nothing was changed.",
};

const INELIGIBLE_COPY: Partial<
  Record<ProcessingRetryIneligibleReason, string>
> = {
  attempts_exhausted: "No retries are left for this meeting.",
  notes_edited: "Retry is unavailable because these notes were edited.",
  source_missing: SOURCE_MISSING_COPY,
  capture_incomplete:
    "Some audio was never recorded, so a retry cannot recover it.",
};

const formatAttemptsLeft = (count: number) =>
  count === 1 ? "1 attempt left." : `${count} attempts left.`;

/** Discord footers share getMeetingProcessingNotice, so this summary notice stays portal-only. */
function summaryNotice(
  processing: MeetingProcessingOutcome | undefined,
  notes: string,
): string | undefined {
  if (processing?.summary !== "failed") return undefined;
  if (getMeetingProcessingNotice(processing, Boolean(notes.trim())))
    return undefined;
  return "The summary could not be generated for this recording.";
}

function outcomeNotice(view: ProcessingRetryView): string | undefined {
  if (view.status === "failed") {
    const reason = FAILURE_COPY[view.failureReason ?? "unknown"];
    // Attempts left only means something while another retry is offered.
    return view.eligible && view.attemptsRemaining > 0
      ? `${reason} ${formatAttemptsLeft(view.attemptsRemaining)}`
      : reason;
  }
  if (view.status === "succeeded" && view.settingsSource === "current")
    return "This retry used the server's current settings.";
  return undefined;
}

function retryNotices(view: ProcessingRetryView, props: Props): string[] {
  const notices = [
    summaryNotice(props.processing, props.notes),
    outcomeNotice(view),
    view.reason ? INELIGIBLE_COPY[view.reason] : undefined,
  ].filter((notice): notice is string => Boolean(notice));
  return [...new Set(notices)];
}

type RetryModalProps = {
  opened: boolean;
  requiresReplaceConfirm: boolean;
  onClose(): void;
  onConfirm(): void;
};

function RetryModal({
  opened,
  requiresReplaceConfirm,
  onClose,
  onConfirm,
}: RetryModalProps) {
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const close = () => {
    setReplaceConfirmed(false);
    onClose();
  };
  return (
    <Modal opened={opened} onClose={close} title="Retry processing?" centered>
      <Stack gap="sm">
        <Text size="sm">
          Chronote will re-run the steps that failed and update this meeting and
          its Discord posts.
        </Text>
        {requiresReplaceConfirm ? (
          <>
            <Text size="sm">
              This replaces the current notes with newly generated notes.
            </Text>
            <Checkbox
              label="Replace the current notes"
              checked={replaceConfirmed}
              onChange={(event) =>
                setReplaceConfirmed(event.currentTarget.checked)
              }
            />
          </>
        ) : null}
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={requiresReplaceConfirm && !replaceConfirmed}
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            Retry
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function MeetingProcessingRetry(props: Props) {
  const { view, pending, onRetry } = props;
  const [modalOpened, setModalOpened] = useState(false);
  const active = view.status === "queued" || view.status === "running";
  const notices = retryNotices(view, props);
  if (!active && !view.eligible && notices.length === 0) return null;
  return (
    <>
      <Group gap="sm" align="center" wrap="wrap">
        {active || notices.length > 0 ? (
          <Stack gap={4} style={{ flex: 1, minWidth: "12rem" }}>
            {active ? (
              <Group gap="xs" role="status" wrap="nowrap">
                <Loader size="xs" />
                <Text size="sm">
                  Retrying processing. This can take a few minutes.
                </Text>
              </Group>
            ) : null}
            {notices.map((notice) => (
              <Text key={notice} size="sm" c="dimmed">
                {notice}
              </Text>
            ))}
          </Stack>
        ) : null}
        {view.eligible ? (
          <Button
            size="xs"
            variant="light"
            loading={pending}
            onClick={() => setModalOpened(true)}
          >
            Retry processing
          </Button>
        ) : null}
      </Group>
      <RetryModal
        opened={modalOpened}
        requiresReplaceConfirm={view.requiresReplaceConfirm}
        onClose={() => setModalOpened(false)}
        onConfirm={() => onRetry(view.requiresReplaceConfirm)}
      />
    </>
  );
}
