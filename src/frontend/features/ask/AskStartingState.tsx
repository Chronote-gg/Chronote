import { Button, Group, Paper, Stack, Text, TextInput } from "@mantine/core";

export type AskContextMeeting = {
  id: string;
  title: string;
  timestamp: string;
};

export type AskStartingStateProps = {
  hideScope?: boolean;
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
};

function scopeText({
  loading,
  failed,
  count,
  notesCount,
  searchQuery = "",
  coverage,
}: AskStartingStateProps) {
  if (loading) return "Checking meeting history...";
  if (failed) return "Meeting history could not be loaded.";
  if (count === 0) return "No matching meetings are available to Ask.";
  if (count !== undefined)
    return `${count} accessible meetings in this view${notesCount === undefined ? "" : ` (${notesCount} with notes)`}`;
  if (searchQuery.trim()) return "Matching accessible meetings";
  if (coverage === "ready")
    return "Ask about accessible retained meeting history.";
  return "Meeting coverage is not yet confirmed.";
}
function CoverageNotice({ coverage, semanticCoverage }: AskStartingStateProps) {
  if (coverage && coverage !== "ready")
    return (
      <Text size="xs" c="dimmed" role="note">
        {coverage === "partial"
          ? "Search is still catching up. Some accessible meetings may be missing."
          : "Search is unavailable. Complete library coverage is not confirmed."}
      </Text>
    );
  if (coverage === "ready" && semanticCoverage && semanticCoverage !== "ready")
    return (
      <Text size="xs" c="dimmed" role="note">
        Semantic search is still catching up. Keyword results may be available.
      </Text>
    );
  return null;
}
function ContextCards({
  meetings,
  hideScope,
  loading,
  failed,
  count,
  selectedIds,
  onSelect,
}: AskStartingStateProps) {
  if (!meetings.length) {
    if (loading || failed || !count) return null;
    return (
      <Text size="sm" c="dimmed">
        These meetings do not have notes yet.
      </Text>
    );
  }
  return (
    <>
      {!hideScope ? (
        <Text size="xs" fw={600}>
          Meetings
        </Text>
      ) : null}
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
              {selectedIds.includes(meeting.id) ? "Added" : "Add to context"}
            </Button>
          </Group>
        </Paper>
      ))}
    </>
  );
}
export function AskStartingState(props: AskStartingStateProps) {
  const {
    hideScope,
    loading,
    failed,
    onRetry,
    onSearchChange,
    searchQuery = "",
    onExample,
    onLoadMore,
  } = props;
  return (
    <Stack gap={4} w="100%" maw={640} mx="auto">
      {!hideScope || loading || failed ? (
        <Text size="sm" role="status">
          {scopeText(props)}
        </Text>
      ) : null}
      {failed ? (
        <Button variant="subtle" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
      <CoverageNotice {...props} />
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
      <ContextCards {...props} />
      {onLoadMore ? (
        <Button variant="subtle" loading={loading} onClick={onLoadMore}>
          More meetings
        </Button>
      ) : null}
    </Stack>
  );
}
