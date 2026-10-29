import { trpc } from "../services/trpc";
import { LibraryNotionStatus } from "./library/components/LibraryNotionStatus";
import {
  Box,
  Button,
  Checkbox,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import PageHeader from "../components/PageHeader";
import MeetingSources from "../components/MeetingSources";
import { MeetingList } from "../features/library/MeetingList";
import { FiltersBar } from "../features/library/FiltersBar";
import { useMeetingBrowseContext } from "../contexts/MeetingBrowseContext";
import { useGuildContext } from "../contexts/GuildContext";
import { useInvalidateMeetingLists } from "../hooks/useInvalidateMeetingLists";
import {
  meetingBrowseSearchSchema,
  selectMeetingSource,
  type MeetingBrowseSearch,
} from "../utils/meetingBrowseSearch";
import { meetingBrowseScope } from "./hooks/useMeetingBrowse";
import MeetingDetailDrawer from "./library/components/MeetingDetailDrawer";
import { FirstMeetingEmptyState } from "./library/components/FirstMeetingEmptyState";

export default function UnifiedMeetingsPage() {
  const search = meetingBrowseSearchSchema.parse(
    useSearch({ from: "/portal/meetings" }),
  );
  const browse = useMeetingBrowseContext();
  const { guilds } = useGuildContext();
  const navigate = useNavigate({ from: "/portal/meetings" });
  const scope = meetingBrowseScope(search);
  const update = (patch: Partial<MeetingBrowseSearch>) =>
    navigate({
      search: meetingBrowseSearchSchema.parse({ ...search, ...patch }),
    });
  const guild = guilds.find(
    (item) => scope.kind === "guild" && item.id === scope.serverId,
  );
  const notion = trpc.notion.automationStatus.useQuery(
    { serverId: guild?.id ?? "" },
    { enabled: Boolean(guild) },
  );
  const sourceAvailable =
    scope.kind !== "guild" ||
    browse.sources.some((source) => source.id === scope.serverId);
  const drawerGuild = guilds.find((item) => item.id === search.meetingServerId);
  const invalidateMeetingLists = useInvalidateMeetingLists(
    search.meetingServerId ?? null,
  );
  const channelNameMap = new Map(
    browse.rows.map((row) => [row.channelId, row.channelName]),
  );
  const tagOptions = [
    ...new Set(browse.rows.flatMap((row) => row.tags)),
  ].sort();
  const channelOptions = [...channelNameMap].map(([value, label]) => ({
    value,
    label,
  }));
  const filtered = Boolean(
    search.attended ||
    search.q?.trim() ||
    search.tags ||
    search.channelId ||
    search.range !== "all" ||
    search.archive !== "active",
  );
  const completeEmpty =
    sourceAvailable &&
    !browse.isLoading &&
    !browse.error &&
    browse.discoveryComplete &&
    !browse.hasMore &&
    browse.rows.length === 0 &&
    !filtered;
  const openUpload = () => navigate({ to: "/portal/upload" });
  return (
    <Stack gap="lg" data-testid="unified-meetings-page">
      <PageHeader
        title="Meetings"
        description="Recordings you can access, across servers and personal recordings."
      />
      <Box hiddenFrom="sm">
        <MeetingSources
          sources={browse.sources}
          scope={scope}
          onSelect={(next) =>
            navigate({ search: selectMeetingSource(search, next) })
          }
        />
      </Box>
      <LibraryNotionStatus
        status={notion.data}
        canManage={guild?.canManage === true}
        onOpenSettings={() => {
          if (guild)
            void navigate({
              to: "/portal/server/$serverId/settings",
              params: { serverId: guild.id },
            });
        }}
      />
      {!sourceAvailable ? (
        <Text c="dimmed">
          This source is unavailable. Choose another source to browse accessible
          recordings.
        </Text>
      ) : null}
      <Group justify="space-between">
        <Checkbox
          label="Only meetings I attended"
          checked={search.attended}
          onChange={(event) =>
            update({ attended: event.currentTarget.checked })
          }
        />
        <Button onClick={openUpload}>Upload media</Button>
      </Group>
      <FiltersBar
        query={search.q ?? ""}
        onQueryChange={(q) => update({ q })}
        tagOptions={tagOptions}
        selectedTags={search.tags?.split(",").filter(Boolean) ?? []}
        onTagsChange={(tags) => update({ tags: tags.join(",") || undefined })}
        selectedRange={search.range}
        onRangeChange={(range) =>
          update({ range: meetingBrowseSearchSchema.parse({ range }).range })
        }
        archiveFilter={search.archive}
        onArchiveFilterChange={(archive) => update({ archive })}
        selectedChannel={search.channelId ?? null}
        onChannelChange={(channelId) =>
          update({ channelId: channelId ?? undefined })
        }
        channelOptions={channelOptions}
      />
      {search.range === "custom" ? (
        <Group>
          <TextInput
            label="From"
            type="datetime-local"
            value={search.startDate?.slice(0, 16) ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value) update({ startDate: new Date(value).toISOString() });
            }}
          />
          <TextInput
            label="Until"
            type="datetime-local"
            value={search.endDate?.slice(0, 16) ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value) update({ endDate: new Date(value).toISOString() });
            }}
          />
        </Group>
      ) : null}
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {browse.items.length} loaded meetings
          {browse.hasMore ? ", more available" : ""}
        </Text>
        <Group>
          <Button
            variant="subtle"
            onClick={() =>
              navigate({
                search: meetingBrowseSearchSchema.parse({
                  scope: search.scope,
                  serverId: search.serverId,
                }),
              })
            }
          >
            Clear filters
          </Button>
          <Button variant="subtle" onClick={() => void browse.refresh()}>
            Refresh
          </Button>
        </Group>
      </Group>
      {completeEmpty && scope.kind === "guild" ? (
        <FirstMeetingEmptyState
          serverName={
            guild?.name ??
            browse.sources.find((source) => source.id === scope.serverId)?.name
          }
          discordUrl={`https://discord.com/channels/${encodeURIComponent(scope.serverId)}`}
          optionalSetupUrl={
            guild?.canManage
              ? `/join?serverId=${encodeURIComponent(scope.serverId)}#optional-setup`
              : undefined
          }
        />
      ) : completeEmpty ? (
        <Stack>
          <Text>
            {scope.kind === "personal"
              ? "Upload your first personal recording."
              : "Choose a source or upload your first recording."}
          </Text>
          <Button onClick={openUpload}>Upload recording</Button>
        </Stack>
      ) : (
        <MeetingList
          items={browse.items}
          listLoading={browse.isLoading}
          listError={Boolean(browse.error)}
          selectedMeetingId={search.meetingId ?? null}
          onSelect={(id) => {
            const row = browse.items.find((item) => item.id === id);
            if (row?.serverId)
              void update({ meetingId: row.id, meetingServerId: row.serverId });
          }}
          emptyTitle={
            browse.hasMore || !browse.discoveryComplete
              ? "Still checking accessible recordings."
              : "No meetings match these filters."
          }
        />
      )}
      {browse.hasMore ? (
        <Button loading={browse.isFetching} onClick={browse.loadMore}>
          Load more
        </Button>
      ) : null}
      {search.meetingId && search.meetingServerId ? (
        <MeetingDetailDrawer
          key={`${search.meetingServerId}/${search.meetingId}`}
          opened
          selectedMeetingId={search.meetingId}
          selectedGuildId={search.meetingServerId}
          canManageSelectedGuild={drawerGuild?.canManage === true}
          channelNameMap={channelNameMap}
          invalidateMeetingLists={invalidateMeetingLists}
          onFullScreenChange={(fullScreen) =>
            update({ fullScreen: fullScreen || undefined })
          }
          onClose={() =>
            update({
              meetingId: undefined,
              meetingServerId: undefined,
              eventId: undefined,
              fullScreen: undefined,
            })
          }
        />
      ) : null}
    </Stack>
  );
}
