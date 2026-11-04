import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import Surface from "../../../components/Surface";
import { MeetingProcessingRetry } from "./MeetingProcessingRetry";

const meta: Meta<typeof MeetingProcessingRetry> = {
  title: "Library/MeetingProcessingRetry",
  component: MeetingProcessingRetry,
  render: (args) => (
    <Surface p="md" style={{ maxWidth: 500 }}>
      <MeetingProcessingRetry {...args} />
    </Surface>
  ),
  args: {
    view: {
      eligible: true,
      requiresReplaceConfirm: false,
      attemptsRemaining: 3,
    },
    pending: false,
    onRetry: () => undefined,
    notes: "",
    processing: { transcription: "ready", notes: "failed", summary: "skipped" },
  },
};

export default meta;

type Story = StoryObj<typeof MeetingProcessingRetry>;

export const Eligible: Story = {};

export const ReplaceNotes: Story = {
  args: {
    view: {
      eligible: true,
      requiresReplaceConfirm: true,
      attemptsRemaining: 3,
    },
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Retry processing" }),
    );
    const dialog = await waitFor(() =>
      within(document.body).getByRole("dialog", { name: "Retry processing?" }),
    );
    await expect(
      within(dialog).getByRole("button", { name: "Retry" }),
    ).toBeDisabled();
  },
};

export const Running: Story = {
  args: {
    view: {
      eligible: false,
      reason: "job_active",
      requiresReplaceConfirm: false,
      status: "running",
      attemptsRemaining: 2,
    },
  },
};

export const Failed: Story = {
  args: {
    view: {
      eligible: true,
      requiresReplaceConfirm: false,
      status: "failed",
      failureReason: "stage_failed",
      attemptsRemaining: 2,
    },
  },
};

export const UsedCurrentSettings: Story = {
  args: {
    view: {
      eligible: false,
      reason: "nothing_failed",
      requiresReplaceConfirm: false,
      status: "succeeded",
      settingsSource: "current",
      attemptsRemaining: 2,
    },
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    notes: "- Generated synthetic notes.",
  },
};

export const AttemptsExhausted: Story = {
  args: {
    view: {
      eligible: false,
      reason: "attempts_exhausted",
      requiresReplaceConfirm: false,
      status: "failed",
      failureReason: "stage_failed",
      attemptsRemaining: 0,
    },
  },
};
