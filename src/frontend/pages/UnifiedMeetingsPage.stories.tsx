import type { Meta, StoryObj } from "@storybook/react";
import { UnifiedMeetingsPreview } from "../storybook/UnifiedMeetingsPreview";
const meta = {
  title: "Meetings/Unified",
  component: UnifiedMeetingsPreview,
  tags: ["unified-meetings"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof UnifiedMeetingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MixedAll: Story = {};
export const SelectedGuild: Story = {
  args: { path: "/portal/meetings?scope=guild&serverId=engineering" },
};
export const Attended: Story = {
  args: { path: "/portal/meetings?attended=true" },
};
export const Personal: Story = {
  args: { path: "/portal/meetings?scope=personal" },
};
export const AllEmpty: Story = { args: { scenario: "empty" } };
export const PersonalEmpty: Story = {
  args: { scenario: "empty", path: "/portal/meetings?scope=personal" },
};
export const ServerEmpty: Story = {
  args: {
    scenario: "empty",
    path: "/portal/meetings?scope=guild&serverId=engineering",
  },
};
export const FilteredEmpty: Story = {
  args: { path: "/portal/meetings?scope=personal&q=unmatched" },
};
export const RetainedSource: Story = {
  args: { path: "/portal/meetings?scope=guild&serverId=previous" },
};
export const DeniedSource: Story = {
  args: {
    scenario: "error",
    path: "/portal/meetings?scope=guild&serverId=denied",
  },
};
export const Loading: Story = { args: { scenario: "loading" } };
export const Error: Story = { args: { scenario: "error" } };
export const Drawer: Story = {
  args: {
    path: "/portal/meetings?meetingServerId=engineering&meetingId=record-0",
  },
};
export const LongSources: Story = {
  args: { manySources: true, scenario: "long" },
};
export const Mobile: Story = { args: { manySources: true, scenario: "long" } };
export const Tablet: Story = { args: { scenario: "long" } };
export const Light: Story = { args: { colorScheme: "light" } };
