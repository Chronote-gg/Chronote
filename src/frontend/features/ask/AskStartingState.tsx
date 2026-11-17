import { Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";

export type AskContextMeeting = {
  id: string;
  title: string;
  timestamp: string;
};

export function AskStartingState({
  count,
  notesCount,
  meetings,
  loading,
  failed,
  selectedIds,
  onSelect,
  onExample,
  onRetry,
  searchQuery = "",
  onSearchChange,
  onLoadMore,
  coverage,
  semanticCoverage,
}: {
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  onLoadMore?: () => void;
  coverage?: "ready" | "partial" | "unavailable";
  semanticCoverage?: "ready" | "partial" | "unavailable";
  count?: number;
  notesCount?: number;
  meetings: AskContextMeeting[];
  loading: boolean;
  failed: boolean;
  selectedIds: string[];
  onSelect: (meeting: AskContextMeeting) => void;
  onExample: (question: string) => void;
  onRetry: () => void;
}) {
  return (
    <Stack gap={4} w="100%" maw={640} mx="auto">
      <Text size="sm" role="status">
        {loading
          ? "Checking meeting history..."
          : failed
            ? "Meeting history could not be loaded."
            : count === 0
              ? "No matching meetings are available to Ask."
              : count === undefined
                ? searchQuery.trim()
                  ? "Matching accessible meetings"
                  : coverage === "ready"
                    ? "Ask about accessible retained meeting history."
                    : "Meeting coverage is not yet confirmed."
                : `${count} accessible meetings in this view${notesCount === undefined ? "" : ` (${notesCount} with notes)`}`}
      </Text>
      {failed ? (
        <Button variant="subtle" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
      {coverage && coverage !== "ready" ? (
        <Text size="xs" c="dimmed" role="note">
          {coverage === "partial"
            ? "Search is still catching up. Some accessible meetings may be missing."
            : "Search is unavailable. Complete library coverage is not confirmed."}
        </Text>
      ) : null}
      {coverage === "ready" &&
      semanticCoverage &&
      semanticCoverage !== "ready" ? (
        <Text size="xs" c="dimmed" role="note">
          Semantic search is still catching up. Keyword results may be
          available.
        </Text>
      ) : null}
      {onSearchChange ? (
        <TextInput
          label="Find meeting context"
          placeholder="Search titles, summaries and notes"
          value={searchQuery}
          onChange={(event) => onSearchChange(event.currentTarget.value)}
        />
      ) : null}
      <Group gap="xs">
        {[
          {
            label: "Decisions",
            question: "What decisions were made in our meetings?",
          },
          {
            label: "Action items",
            question: "What action items were recorded, and who owns them?",
          },
        ].map(({ label, question }) => (
          <Button
            key={question}
            variant="light"
            size="xs"
            styles={{ label: { whiteSpace: "normal", textAlign: "left" } }}
            onClick={() => onExample(question)}
          >
            {label}
          </Button>
        ))}
      </Group>
      {meetings.length ? (
        <>
          <Text size="xs" fw={600}>
            Meetings
          </Text>
          {meetings.map((meeting) => (
            <Paper key={meeting.id} withBorder p="xs">
              <Group justify="space-between" wrap="nowrap">
                <Stack gap={0}>
                  <Text size="sm" fw={500}>
                    {meeting.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {new Date(meeting.timestamp).toLocaleDateString()}
                  </Text>
                </Stack>
                <Button
                  size="xs"
                  variant="light"
                  disabled={
                    selectedIds.includes(meeting.id) || selectedIds.length >= 3
                  }
                  onClick={() => onSelect(meeting)}
                >
                  {selectedIds.includes(meeting.id)
                    ? "Added"
                    : "Add to context"}
                </Button>
              </Group>
            </Paper>
          ))}
        </>
      ) : !loading && !failed && count ? (
        <Text size="sm" c="dimmed">
          These meetings do not have notes yet.
        </Text>
      ) : null}
      {onLoadMore ? (
        <Button variant="subtle" loading={loading} onClick={onLoadMore}>
          More meetings
        </Button>
      ) : null}
    </Stack>
  );
}
