import { useState } from "react";
import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { IconExternalLink, IconSettings } from "@tabler/icons-react";
import PageHeader from "../../components/PageHeader";
import { RefreshButton } from "../../components/RefreshButton";
import Surface from "../../components/Surface";
import { useGuildContext } from "../../contexts/GuildContext";
import { FiltersBar } from "../../features/library/FiltersBar";
import { MeetingList } from "../../features/library/MeetingList";
import { trpc } from "../../services/trpc";
import { useLibraryMeetings } from "./hooks/useLibraryMeetings";
import type { ArchiveFilter } from "./types";

export default function LibraryPage() {
  const navigate = useNavigate({ from: "/portal/server/$serverId/library" });
  const search = useSearch({ from: "/portal/server/$serverId/library" });
  const { selectedGuildId, guilds } = useGuildContext();

  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedRange, setSelectedRange] = useState("30");
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active");

  const selectedMeetingId = search.meetingId ?? null;
  const selectedGuild = selectedGuildId
    ? (guilds.find((guild) => guild.id === selectedGuildId) ?? null)
    : null;
  const canManageSelectedGuild = selectedGuild?.canManage ?? false;
  const notionStatusQuery = trpc.notion.automationStatus.useQuery(
    { serverId: selectedGuildId ?? "" },
    { enabled: Boolean(selectedGuildId) },
  );
  const notionAutomation = notionStatusQuery.data?.automation;
  const showNotionStatus =
    notionStatusQuery.data?.configured &&
    (Boolean(notionAutomation) || canManageSelectedGuild);
  const notionStatusTone = !notionAutomation
    ? "blue"
    : !notionAutomation.enabled
      ? "gray"
      : notionAutomation.lastError || !notionAutomation.ownerConnected
        ? "red"
        : "teal";
  const notionStatusCopy = !notionAutomation
    ? "Notion automation is available. Choose a shared destination in Settings to auto-export completed meetings."
    : !notionAutomation.enabled
      ? "Notion automation is configured but paused for this server."
      : notionAutomation.lastError || !notionAutomation.ownerConnected
        ? "Notion automation needs attention before exports can recover."
        : `Notion auto-export is on${
            notionAutomation.destinationTitle
              ? ` to ${notionAutomation.destinationTitle}`
              : ""
          }.`;

  const {
    filteredMeetings,
    tagOptions,
    channelOptions,
    listLoading,
    listError,
    handleRefresh,
  } = useLibraryMeetings({
    selectedGuildId: selectedGuildId ?? null,
    archiveFilter,
    query,
    selectedTags,
    selectedChannel,
    selectedRange,
  });

  return (
    <Stack gap="lg" data-testid="library-page">
      <PageHeader
        title="Library"
        description="Every session, indexed by tags, channel, and timeline."
      />

      {showNotionStatus ? (
        <Surface p="md" data-testid="library-notion-status">
          <Group justify="space-between" align="center" wrap="wrap">
            <Group gap="sm" align="center" wrap="wrap">
              <Badge color={notionStatusTone} variant="light">
                Notion
              </Badge>
              <Text size="sm" c="dimmed">
                {notionStatusCopy}
              </Text>
            </Group>
            <Group gap="xs">
              {notionAutomation?.destinationUrl ? (
                <Button
                  component="a"
                  href={notionAutomation.destinationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="subtle"
                  size="xs"
                  leftSection={<IconExternalLink size={14} />}
                >
                  Open destination
                </Button>
              ) : null}
              {canManageSelectedGuild && selectedGuildId ? (
                <Button
                  variant="light"
                  size="xs"
                  leftSection={<IconSettings size={14} />}
                  onClick={() =>
                    navigate({
                      to: `/portal/server/${selectedGuildId}/settings`,
                    })
                  }
                >
                  Notion settings
                </Button>
              ) : null}
            </Group>
          </Group>
        </Surface>
      ) : null}

      <FiltersBar
        query={query}
        onQueryChange={setQuery}
        tagOptions={tagOptions}
        selectedTags={selectedTags}
        onTagsChange={setSelectedTags}
        selectedRange={selectedRange}
        onRangeChange={(value) => setSelectedRange(value)}
        archiveFilter={archiveFilter}
        onArchiveFilterChange={setArchiveFilter}
        selectedChannel={selectedChannel}
        onChannelChange={setSelectedChannel}
        channelOptions={channelOptions}
      />

      <Group justify="space-between" align="center" wrap="wrap">
        <Group gap="sm" align="center" wrap="wrap">
          <Text c="dimmed" size="sm">
            {filteredMeetings.length}{" "}
            {archiveFilter === "archived" ? "archived meetings" : "meetings"}
          </Text>
        </Group>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Sorted by recency |{" "}
            {selectedRange === "all"
              ? "All time"
              : `Range: ${selectedRange} days`}
          </Text>
          <RefreshButton
            onClick={handleRefresh}
            size="xs"
            variant="subtle"
            data-testid="library-refresh-top"
          />
        </Group>
      </Group>
      <MeetingList
        items={filteredMeetings}
        listLoading={listLoading}
        listError={listError}
        onSelect={(meetingId) =>
          navigate({
            search: (prev) => ({
              ...prev,
              meetingId,
            }),
          })
        }
        selectedMeetingId={selectedMeetingId}
      />
      <Group justify="flex-end">
        <RefreshButton
          onClick={handleRefresh}
          size="xs"
          variant="subtle"
          data-testid="library-refresh"
        />
      </Group>
    </Stack>
  );
}
