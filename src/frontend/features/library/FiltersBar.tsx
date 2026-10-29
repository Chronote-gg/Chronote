import { SimpleGrid, TextInput, MultiSelect } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import Surface from "../../components/Surface";
import FormSelect from "../../components/FormSelect";

type FiltersBarProps = {
  query: string;
  onQueryChange: (value: string) => void;
  tagOptions: string[];
  selectedTags: string[];
  onTagsChange: (tags: string[]) => void;
  selectedRange: string;
  onRangeChange: (value: string) => void;
  archiveFilter: "active" | "archived" | "all";
  onArchiveFilterChange: (value: "active" | "archived" | "all") => void;
  selectedChannel: string | null;
  onChannelChange: (value: string | null) => void;
  channelOptions: { value: string; label: string }[];
};

export function FiltersBar({
  query,
  onQueryChange,
  tagOptions,
  selectedTags,
  onTagsChange,
  selectedRange,
  onRangeChange,
  archiveFilter,
  onArchiveFilterChange,
  selectedChannel,
  onChannelChange,
  channelOptions,
}: FiltersBarProps) {
  return (
    <Surface p="lg" tone="soft">
      <SimpleGrid cols={{ base: 1, md: 5 }} spacing="md">
        <TextInput
          value={query}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
          placeholder="Search loaded meetings"
          aria-label="Search loaded meetings"
          leftSection={<IconSearch size={16} />}
          data-testid="library-search"
        />
        <MultiSelect
          data={tagOptions}
          placeholder="Tags"
          value={selectedTags}
          onChange={onTagsChange}
          searchable
          clearable
        />
        <FormSelect
          value={archiveFilter}
          onChange={(value) =>
            onArchiveFilterChange(
              value === "archived" || value === "all" ? value : "active",
            )
          }
          data-testid="library-archive-filter"
          data={[
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
            { value: "all", label: "All" },
          ]}
        />
        <FormSelect
          value={selectedRange}
          onChange={(value) => onRangeChange(value || "30")}
          data-testid="library-range"
          data={[
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
            { value: "today", label: "Today" },
            { value: "custom", label: "Custom dates" },
            { value: "all", label: "All time" },
          ]}
        />
        <FormSelect
          placeholder="Channel"
          value={selectedChannel}
          onChange={onChannelChange}
          data-testid="library-channel"
          data={channelOptions}
          clearable
        />
      </SimpleGrid>
    </Surface>
  );
}
