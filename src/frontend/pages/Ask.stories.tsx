import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { AskPreview } from "../storybook/AskPreview";

const meta = {
  title: "Pages/Ask starting",
  component: AskPreview,
  tags: ["ask-starting"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AskPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Desktop: Story = {};
export const DesktopShort: Story = {};
export const Mobile: Story = {};
export const Empty: Story = { args: { scenario: "empty" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const Error: Story = { args: { scenario: "error" } };
export const NotesPending: Story = { args: { scenario: "no-notes" } };
export const SubmissionFailure: Story = { args: { submissionFails: true } };
export const SelectedContext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const add = await canvas.findAllByRole("button", {
      name: "Add to context",
    });
    await userEvent.click(add[0]);
    await expect(
      canvas.getByText("Included with your next question as meeting context"),
    ).toBeVisible();
    const input = canvas.getByTestId("ask-input");
    await expect(input).toHaveValue("");
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Decisions",
      }),
    );
    await expect(input).toHaveValue(
      "What decisions were made in our meetings?",
    );
    await expect(canvas.queryByTestId("ask-message-user")).toBeNull();
  },
};

export const SearchContext: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add meeting context" }),
    );
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Find meeting context" }),
      "earlier",
    );
    await expect(
      await within(dialog).findByText("Earlier planning"),
    ).toBeVisible();
  },
};

export const RecentHistoryShort: Story = {
  args: { agentEnabled: false, searchEnabled: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("note")).toHaveTextContent(
      "Recent history mode: answers use up to 25 recent accessible meetings. Full history search is not enabled yet.",
    );
    await expect(
      canvas.queryByRole("button", { name: "Add meeting context" }),
    ).toBeNull();
  },
};
export const RecentHistoryMobile: Story = {
  args: { agentEnabled: false, searchEnabled: false },
  play: RecentHistoryShort.play,
};
