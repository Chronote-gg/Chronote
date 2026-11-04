import { Group, TextInput } from "@mantine/core";
import { useMeetingBrowseContext } from "../contexts/MeetingBrowseContext";
import { FiltersBar } from "../features/library/FiltersBar";
import {
  formatLocalMeetingDate,
  parseLocalMeetingDate,
} from "../utils/meetingBrowseDates";
import {
  meetingBrowseSearchSchema,
  type MeetingBrowseSearch,
} from "../utils/meetingBrowseSearch";

type ControlsProps = {
  search: MeetingBrowseSearch;
  update: (patch: Partial<MeetingBrowseSearch>) => unknown;
  rows: ReturnType<typeof useMeetingBrowseContext>["rows"];
};
export function UnifiedMeetingControls({
  search,
  update,
  rows,
}: ControlsProps) {
  const channelNameMap = new Map(
    rows.map((row) => [row.channelId, row.channelName]),
  );
  const tagOptions = [...new Set(rows.flatMap((row) => row.tags))].sort();
  const channelOptions = [...channelNameMap].map(([value, label]) => ({
    value,
    label,
  }));
  return (
    <>
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
            value={formatLocalMeetingDate(search.startDate)}
            onChange={(event) => {
              update({
                startDate: parseLocalMeetingDate(event.currentTarget.value),
              });
            }}
          />
          <TextInput
            label="Until"
            type="datetime-local"
            value={formatLocalMeetingDate(search.endDate)}
            onChange={(event) => {
              update({
                endDate: parseLocalMeetingDate(event.currentTarget.value),
              });
            }}
          />
        </Group>
      ) : null}
    </>
  );
}
