import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Group,
  LoadingOverlay,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useAuth } from "../contexts/AuthContext";
import { trpc } from "../services/trpc";
import Surface from "../components/Surface";
import { uiOverlays } from "../uiTokens";
import type { FeedbackRecord } from "../../types/db";

type FilterValue = "all" | "meeting_summary" | "ask_answer";
type RatingValue = "all" | "up" | "down";
type SourceValue = "all" | "discord" | "web";

const resolveTargetLabel = (targetType: string) =>
  targetType === "ask_answer" ? "Ask answer" : "Meeting summary";

const buildFeedbackKey = (item: FeedbackRecord) => `${item.pk}:${item.sk}`;

const mergeFeedbackItems = (
  existing: FeedbackRecord[],
  next: FeedbackRecord[],
) => {
  const map = new Map<string, FeedbackRecord>();
  existing.forEach((item) => map.set(buildFeedbackKey(item), item));
  next.forEach((item) => map.set(buildFeedbackKey(item), item));
  return Array.from(map.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
};

function AdminFeedbackAccessDenied() {
  return (
    <Surface tone="soft" p="xl">
      <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
        Super admin access is required to view this page.
      </Alert>
    </Surface>
  );
}

export default function AdminFeedback() {
  const { user } = useAuth();
  const isSuperAdmin = Boolean(user?.isSuperAdmin);
  const [targetType, setTargetType] = useState<FilterValue>("all");
  const [rating, setRating] = useState<RatingValue>("all");
  const [source, setSource] = useState<SourceValue>("all");
  const [items, setItems] = useState<FeedbackRecord[]>([]);
  const [guildsById, setGuildsById] = useState<Record<string, string>>({});
  const [pageCursor, setPageCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  const query = trpc.adminFeedback.list.useQuery(
    {
      targetType: targetType === "all" ? undefined : targetType,
      rating: rating === "all" ? undefined : rating,
      source: source === "all" ? undefined : source,
      limit: 100,
      cursor: pageCursor ?? undefined,
    },
    {
      enabled: isSuperAdmin,
    },
  );

  useEffect(() => {
    setItems([]);
    setGuildsById({});
    setPageCursor(null);
    setNextCursor(null);
    setIsLoadingMore(false);
  }, [targetType, rating, source, isSuperAdmin]);

  useEffect(() => {
    if (!query.data) return;
    const incomingGuilds = query.data.guildsById ?? {};
    setItems((prev) =>
      pageCursor
        ? mergeFeedbackItems(prev, query.data.items)
        : query.data.items,
    );
    setGuildsById((prev) =>
      pageCursor ? { ...prev, ...incomingGuilds } : incomingGuilds,
    );
    setNextCursor(query.data.nextCursor ?? null);
    setIsLoadingMore(false);
  }, [pageCursor, query.data]);

  const handleLoadMore = () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    setPageCursor(nextCursor);
  };

  const handleRefresh = () => {
    setItems([]);
    setGuildsById({});
    setNextCursor(null);
    setPageCursor(null);
    void query.refetch();
  };
  const stats = useMemo(() => {
    const totals = {
      meeting_summary: { up: 0, down: 0 },
      ask_answer: { up: 0, down: 0 },
    };
    items.forEach((item) => {
      const target =
        item.targetType === "ask_answer" ? "ask_answer" : "meeting_summary";
      if (item.rating === "up") {
        totals[target].up += 1;
      } else {
        totals[target].down += 1;
      }
    });
    return totals;
  }, [items]);

  if (!isSuperAdmin) {
    return <AdminFeedbackAccessDenied />;
  }

  return (
    <Stack gap="lg" data-testid="admin-feedback-page">
      <Group justify="space-between" align="center">
        <Stack gap={2}>
          <Title order={2}>Feedback</Title>
          <Text size="sm" c="dimmed">
            Recent feedback on meeting summaries and Ask answers.
          </Text>
        </Stack>
        <Button
          variant="default"
          onClick={handleRefresh}
          disabled={query.isLoading}
          data-testid="admin-feedback-refresh"
        >
          Refresh
        </Button>
      </Group>

      <Group gap="sm" align="flex-end" wrap="wrap">
        <Select
          label="Target"
          data={[
            { value: "all", label: "All" },
            { value: "meeting_summary", label: "Meeting summaries" },
            { value: "ask_answer", label: "Ask answers" },
          ]}
          value={targetType}
          onChange={(value) => setTargetType((value as FilterValue) ?? "all")}
        />
        <Select
          label="Rating"
          data={[
            { value: "all", label: "All" },
            { value: "up", label: "Thumbs up" },
            { value: "down", label: "Thumbs down" },
          ]}
          value={rating}
          onChange={(value) => setRating((value as RatingValue) ?? "all")}
        />
        <Select
          label="Source"
          data={[
            { value: "all", label: "All" },
            { value: "web", label: "Web" },
            { value: "discord", label: "Discord" },
          ]}
          value={source}
          onChange={(value) => setSource((value as SourceValue) ?? "all")}
        />
      </Group>

      <Group gap="sm" wrap="wrap">
        <Badge variant="light" color="gray">
          Meeting summaries: {stats.meeting_summary.up} up,{" "}
          {stats.meeting_summary.down} down
        </Badge>
        <Badge variant="light" color="gray">
          Ask answers: {stats.ask_answer.up} up, {stats.ask_answer.down} down
        </Badge>
      </Group>

      <Surface tone="raised" p="lg" style={{ position: "relative" }}>
        <LoadingOverlay
          visible={query.isLoading && items.length === 0}
          overlayProps={uiOverlays.loading}
          loaderProps={{ size: "md" }}
        />
        <Stack gap="md">
          {items.length === 0 ? (
            <Text size="sm" c="dimmed">
              No feedback yet.
            </Text>
          ) : (
            items.map((item) => {
              const ratingColor = item.rating === "up" ? "teal" : "red";
              const displayName = item.displayName?.trim() || "Unknown";
              const userTag = item.userTag?.trim() || item.userId || "Unknown";
              const guildLabel = item.guildId
                ? `${guildsById[item.guildId] ?? "Unknown guild"} (${
                    item.guildId
                  })`
                : "Unknown guild";
              return (
                <Surface key={`${item.pk}:${item.sk}`} tone="soft" p="md">
                  <Group justify="space-between" align="center" wrap="wrap">
                    <Group gap="xs" wrap="wrap">
                      <Badge color={ratingColor} variant="light">
                        {item.rating === "up" ? "Thumbs up" : "Thumbs down"}
                      </Badge>
                      <Badge variant="light" color="gray">
                        {resolveTargetLabel(item.targetType)}
                      </Badge>
                      <Badge variant="light" color="gray">
                        {item.source === "discord" ? "Discord" : "Web"}
                      </Badge>
                    </Group>
                    <Text size="xs" c="dimmed">
                      {new Date(item.createdAt).toLocaleString()}
                    </Text>
                  </Group>
                  <Stack gap={4} mt="xs">
                    <Text size="sm">
                      {item.comment ? item.comment : "No comment provided."}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Display name: {displayName}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Discord username: {userTag}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Guild: {guildLabel}
                    </Text>
                    <Text size="xs" c="dimmed">
                      Target: {item.targetId}
                    </Text>
                  </Stack>
                </Surface>
              );
            })
          )}
          {nextCursor ? (
            <Button
              variant="light"
              onClick={handleLoadMore}
              loading={isLoadingMore}
              disabled={query.isFetching}
            >
              Load more
            </Button>
          ) : null}
        </Stack>
      </Surface>
    </Stack>
  );
}
