import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { UpgradePreview } from "../../storybook/UpgradePreview";

const meta = {
  title: "Library/FirstMeetingPage",
  tags: ["first-meeting"],
  component: UpgradePreview,
  args: { path: "/portal/server/example/library" },
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const RefreshAndArchive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "Your first meeting in Engineering HQ goes here.",
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Refresh", exact: true }),
    ).toBeVisible();

    await expect(canvas.queryByTestId("library-search")).toBeInTheDocument();
  },
};
export const RefreshAndArchiveMobile: Story = { ...RefreshAndArchive };
