import type { Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { useMantineColorScheme } from "@mantine/core";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { FirstMeetingEmptyState } from "./FirstMeetingEmptyState";

function EmptyStatePreview({
  colorScheme = "dark",
}: {
  colorScheme?: "light" | "dark";
}) {
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => setColorScheme(colorScheme), [colorScheme, setColorScheme]);
  return (
    <div
      data-testid="empty-state-width"
      style={{ padding: 16, background: "var(--mantine-color-body)" }}
    >
      <FirstMeetingEmptyState
        discordUrl="https://discord.com/channels/12345678901234567890"
        optionalSetupUrl="/join?serverId=12345678901234567890#optional-setup"
      />
    </div>
  );
}
const meta = {
  title: "Library/FirstMeetingEmptyState",
  tags: ["first-meeting"],
  component: EmptyStatePreview,
} satisfies Meta<typeof EmptyStatePreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StepsAndExample: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Your first meeting goes here." }),
    ).toBeVisible();
    await expect(
      canvas.getByText("Example notes · Fictional meeting"),
    ).toBeVisible();
    const open = canvas.getByRole("link", { name: "Open Discord" });
    await expect(open).toHaveAttribute(
      "href",
      "https://discord.com/channels/12345678901234567890",
    );
    const details = canvas.getByText("Optional setup").closest("details");
    await expect(details).not.toHaveAttribute("open");
    const root = canvas.getByTestId("first-meeting-empty-state");
    const wrapper = canvas.getByTestId("empty-state-width");
    const example = canvas.getByTestId("sample-summary");
    await expect(
      root.querySelector("ol")!.compareDocumentPosition(example) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const style = getComputedStyle(root);
    const insets =
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      parseFloat(style.borderLeftWidth) +
      parseFloat(style.borderRightWidth);
    for (const width of [599, 601, 799, 801]) {
      root.style.width = `${width + insets}px`;
      await waitFor(() => {
        const steps = root.querySelector("ol")!;
        const a = steps.children[0].getBoundingClientRect();
        const b = steps.children[1].getBoundingClientRect();
        const instruction = open.getBoundingClientRect();
        const sample = example.getBoundingClientRect();
        expect(
          Math.round(
            root.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
          ),
        ).toBe(width);
        if (width < 800) expect(sample.top).toBeGreaterThan(instruction.bottom);
        else expect(sample.left).toBeGreaterThan(instruction.right);
        if (width >= 600 && width < 800)
          expect(Math.abs(a.top - b.top)).toBeLessThan(2);
        else expect(b.top).toBeGreaterThan(a.top);
        expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
      });
    }
    root.style.width = "";
    await expect(wrapper.scrollWidth).toBeLessThanOrEqual(wrapper.clientWidth);
    await userEvent.click(canvas.getByText("Optional setup"));
    await expect(canvas.getByText("/context", { exact: true })).toBeVisible();
    await expect(
      canvas.getByText("/autorecord", { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Read about optional setup" }),
    ).toHaveAttribute(
      "href",
      "/join?serverId=12345678901234567890#optional-setup",
    );
    await userEvent.click(canvas.getByText("Optional setup"));
    canvas.getByText("Optional setup").blur();
  },
};
export const StepsAndExampleLight: Story = {
  ...StepsAndExample,
  args: { colorScheme: "light" },
};
export const StepsAndExampleMobile: Story = { ...StepsAndExample };
export const StepsAndExampleTablet: Story = { ...StepsAndExample };
export const StepsAndExampleLightMobile: Story = {
  ...StepsAndExample,
  args: { colorScheme: "light" },
};
export const StepsAndExampleLightTablet: Story = {
  ...StepsAndExample,
  args: { colorScheme: "light" },
};
