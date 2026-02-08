import type { Meta, StoryObj } from "@storybook/react";
import { Box, ScrollArea, Stack, Text } from "@mantine/core";
import MeetingTimeline from "../../../components/MeetingTimeline";
import MeetingFullScreenLayout from "./MeetingFullScreenLayout";

const meta: Meta<typeof MeetingFullScreenLayout> = {
  title: "Library/MeetingFullScreenLayout",
  component: MeetingFullScreenLayout,
};

export default meta;
type Story = StoryObj<typeof MeetingFullScreenLayout>;

const events = Array.from({ length: 60 }, (_, idx) => ({
  id: `event-${idx}`,
  type: "voice" as const,
  speaker: idx % 3 === 0 ? "Alice" : idx % 3 === 1 ? "Bob" : "Sam",
  time: `00:${String(idx).padStart(2, "0")}`,
  text: "Transcript line that should wrap a bit on small screens to force vertical overflow.",
}));

export const Default: Story = {
  render: () => (
    <Box style={{ height: 700, display: "flex" }}>
      <MeetingFullScreenLayout
        left={
          <ScrollArea style={{ flex: 1, minHeight: 0 }} type="always">
            <Stack gap="md" p="md">
              <Text fw={600}>Left panel</Text>
              {Array.from({ length: 20 }, (_, idx) => (
                <Text key={idx} size="sm" c="dimmed">
                  Placeholder content line {idx + 1}
                </Text>
              ))}
            </Stack>
          </ScrollArea>
        }
        right={
          <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <MeetingTimeline
              events={events}
              activeFilters={["voice"]}
              height="100%"
              emptyLabel="No events"
              title="Transcript"
              showFilters={false}
            />
          </Box>
        }
      />
    </Box>
  ),
};
