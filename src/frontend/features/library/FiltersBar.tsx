import {
  Box,
  Button,
  Group,
  Stack,
  SimpleGrid,
  TextInput,
  MultiSelect,
} from "@mantine/core";
import { useState } from "react";
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilters =
    selectedTags.length +
    Number(archiveFilter !== "active") +
    Number(selectedRange !== "all") +
    Number(Boolean(selectedChannel));
  return (
    <Surface p="lg" tone="soft">
      <Stack gap="sm">
        <Group wrap="nowrap" align="center">
          <TextInput
            style={{ flex: 1, minWidth: 0 }}
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search loaded meetings"
            aria-label="Search loaded meetings"
            leftSection={<IconSearch size={16} />}
            data-testid="library-search"
          />
          <Button
            hiddenFrom="sm"
            variant="subtle"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="meeting-secondary-filters"
          >
            {activeFilters ? `Filters (${activeFilters})` : "Filters"}
          </Button>
        </Group>
        <Box
          id="meeting-secondary-filters"
          display={{ base: filtersOpen ? "block" : "none", sm: "block" }}
        >
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} spacing="md">
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
        </Box>
      </Stack>
    </Surface>
  );
}
