import { Button, Modal, Pill, Stack, Text } from "@mantine/core";
import {
  AskStartingState,
  type AskStartingStateProps,
  type AskContextMeeting,
} from "./AskStartingState";
import type { useAskMeetingPicker } from "./useAskMeetingPicker";
import type { ListMode } from "../../utils/askLinks";

type Query = ReturnType<typeof useAskMeetingPicker>["startingContextQuery"];
export function AskModeNotice({
  ready,
  agentEnabled,
}: {
  ready: boolean;
  agentEnabled: boolean;
}) {
  if (!ready || agentEnabled) return null;
  return (
    <Text size="xs" c="dimmed" role="note">
      Recent history mode: answers use up to 25 recent accessible meetings. Full
      history search is not enabled yet.
    </Text>
  );
}
export function AskStartingContext({
  visible,
  agentEnabled,
  query,
  pickerProps,
}: {
  visible: boolean;
  agentEnabled: boolean;
  query: Query;
  pickerProps: AskStartingStateProps;
}) {
  if (!visible) return null;
  return (
    <AskStartingState
      {...pickerProps}
      hideScope={!agentEnabled}
      onSearchChange={undefined}
      searchQuery=""
      meetings={query.data?.meetings ?? []}
      coverage={query.data?.coverage.status}
      semanticCoverage={undefined}
      loading={query.isPending}
      failed={query.isError}
      onLoadMore={undefined}
      onRetry={() => {
        void query.refetch();
      }}
    />
  );
}
export function AskContextAction({
  searchEnabled,
  listMode,
  isArchived,
  pending,
  onOpen,
}: {
  searchEnabled: boolean;
  listMode: ListMode;
  isArchived: boolean;
  pending: boolean;
  onOpen: () => void;
}) {
  if (!searchEnabled || listMode !== "mine" || isArchived) return null;
  return (
    <Button
      variant="subtle"
      size="compact-xs"
      disabled={pending}
      onClick={onOpen}
    >
      Add meeting context
    </Button>
  );
}
export function AskContextChips({
  meetings,
  listMode,
  isArchived,
  pending,
  onRemove,
}: {
  meetings: AskContextMeeting[];
  listMode: ListMode;
  isArchived: boolean;
  pending: boolean;
  onRemove: (id: string) => void;
}) {
  if (!meetings.length || listMode !== "mine" || isArchived) return null;
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed">
        Included with your next question as meeting context
      </Text>
      <Pill.Group>
        {meetings.map((meeting) => (
          <Pill
            key={meeting.id}
            withRemoveButton
            onRemove={() => onRemove(meeting.id)}
            disabled={pending}
          >
            {meeting.title}
          </Pill>
        ))}
      </Pill.Group>
    </Stack>
  );
}
export function AskContextModal({
  opened,
  searchEnabled,
  onClose,
  pickerProps,
}: {
  opened: boolean;
  searchEnabled: boolean;
  onClose: () => void;
  pickerProps: AskStartingStateProps;
}) {
  return (
    <Modal
      opened={opened && searchEnabled}
      onClose={onClose}
      title="Meeting context"
      size="lg"
    >
      <AskStartingState {...pickerProps} />
    </Modal>
  );
}
