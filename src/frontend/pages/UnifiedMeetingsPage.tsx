import { Box, Button, Checkbox, Group, Stack, Text } from "@mantine/core";
import { useNavigate, useSearch } from "@tanstack/react-router";
import MeetingSources from "../components/MeetingSources";
import PageHeader from "../components/PageHeader";
import { useGuildContext } from "../contexts/GuildContext";
import { useMeetingBrowseContext } from "../contexts/MeetingBrowseContext";
import { useInvalidateMeetingLists } from "../hooks/useInvalidateMeetingLists";
import { trpc } from "../services/trpc";
import {
  meetingBrowseSearchSchema,
  selectMeetingSource,
  type MeetingBrowseSearch,
} from "../utils/meetingBrowseSearch";
import { meetingBrowseScope } from "./hooks/useMeetingBrowse";
import { LibraryNotionStatus } from "./library/components/LibraryNotionStatus";
import MeetingDetailDrawer from "./library/components/MeetingDetailDrawer";
import { UnifiedMeetingControls } from "./UnifiedMeetingControls";
import { UnifiedMeetingResults } from "./UnifiedMeetingResults";

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
      <UnifiedMeetingControls
        search={search}
        update={update}
        rows={browse.rows}
      />
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
      <UnifiedMeetingResults
        search={search}
        browse={browse}
        guild={guild}
        sourceAvailable={sourceAvailable}
        update={update}
        openUpload={openUpload}
      />
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
