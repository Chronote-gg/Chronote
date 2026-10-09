import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { UpgradePreview } from "./UpgradePlans.stories";

const meta = {
  title: "Pages/Join",
  tags: ["upgrade-plans"],
  component: UpgradePreview,
  args: { path: "/join" },
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FirstRecording: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "Record your first meeting.",
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Open Discord" }),
    ).toHaveAttribute("href", "https://discord.com/channels/@me");
    await expect(canvas.getByTestId("sample-summary")).toBeVisible();
    await expect(
      canvas.getByText("Example notes · Fictional meeting"),
    ).toBeVisible();
  },
};
export const FirstRecordingLight: Story = {
  ...FirstRecording,
  args: { colorScheme: "light" },
};
export const SignedOut: Story = {
  ...FirstRecording,
  args: { signedIn: false },
};
