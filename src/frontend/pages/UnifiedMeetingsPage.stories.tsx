import type { Meta, StoryObj } from "@storybook/react";
import { UpgradePreview } from "../storybook/UpgradePreview";
const meta = {
  title: "Meetings/Unified",
  component: UpgradePreview,
  tags: ["unified-meetings"],
  args: { path: "/portal/meetings" },
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllEmpty: Story = {};
export const PersonalEmpty: Story = {
  args: { path: "/portal/meetings?scope=personal" },
};
export const ServerEmpty: Story = {
  args: { path: "/portal/meetings?scope=guild&serverId=example" },
};
export const FilteredEmpty: Story = {
  args: { path: "/portal/meetings?scope=personal&attended=true" },
};
export const Mobile: Story = {
  ...ServerEmpty,
  globals: { viewport: { value: "mobile1" } },
};
