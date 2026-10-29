import { Button, Stack, Text } from "@mantine/core";
import { useGuildContext } from "../contexts/GuildContext";
import { useMeetingBrowseContext } from "../contexts/MeetingBrowseContext";
import { MeetingList } from "../features/library/MeetingList";
import { meetingDateRangeState } from "../utils/meetingBrowseDates";
import { type MeetingBrowseSearch } from "../utils/meetingBrowseSearch";
import { meetingBrowseScope } from "./hooks/useMeetingBrowse";
import { FirstMeetingEmptyState } from "./library/components/FirstMeetingEmptyState";

type ResultsProps = {
  search: MeetingBrowseSearch;
  browse: ReturnType<typeof useMeetingBrowseContext>;
  guild: ReturnType<typeof useGuildContext>["guilds"][number] | undefined;
  sourceAvailable: boolean;
  update: (patch: Partial<MeetingBrowseSearch>) => unknown;
  openUpload: () => unknown;
};
function hasBrowseFilters(search: MeetingBrowseSearch) {
  return Boolean(
    search.attended ||
    search.q?.trim() ||
    search.tags ||
    search.channelId ||
    search.range !== "all" ||
    search.archive !== "active",
  );
}
function isCompleteEmpty({
  search,
  browse,
  sourceAvailable,
}: Pick<ResultsProps, "search" | "browse" | "sourceAvailable">) {
  return (
    sourceAvailable &&
    !browse.isLoading &&
    !browse.error &&
    browse.discoveryComplete &&
    !browse.hasMore &&
    browse.rows.length === 0 &&
    !hasBrowseFilters(search)
  );
}

export function UnifiedMeetingResults({
  search,
  browse,
  guild,
  sourceAvailable,
  update,
  openUpload,
}: ResultsProps) {
  const dateRangeState = meetingDateRangeState(search);
  const completeEmpty = isCompleteEmpty({ search, browse, sourceAvailable });
  return (
    <>
      {dateRangeState !== "ready" ? (
        <Text role="status">
          {dateRangeState === "incomplete"
            ? "Choose both dates to load meetings in a custom range."
            : "Choose an end date at or after the start date."}
        </Text>
      ) : completeEmpty ? (
        <CompleteEmpty
          search={search}
          browse={browse}
          guild={guild}
          openUpload={openUpload}
        />
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
    </>
  );
}

function CompleteEmpty({
  search,
  browse,
  guild,
  openUpload,
}: Pick<ResultsProps, "search" | "browse" | "guild" | "openUpload">) {
  const scope = meetingBrowseScope(search);
  return scope.kind === "guild" ? (
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
  ) : (
    <Stack>
      <Text>
        {scope.kind === "personal"
          ? "Upload your first personal recording."
          : "Choose a source or upload your first recording."}
      </Text>
      <Button onClick={openUpload}>Upload recording</Button>
    </Stack>
  );
}
