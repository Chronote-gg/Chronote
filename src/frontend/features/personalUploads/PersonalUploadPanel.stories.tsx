import type { Meta, StoryObj } from "@storybook/react";
import { PersonalUploadPanel } from "./PersonalUploadPanel";

const meta: Meta<typeof PersonalUploadPanel> = {
  title: "Personal Uploads/PersonalUploadPanel",
  component: PersonalUploadPanel,
  args: {
    accept: "audio/mpeg,audio/wav,audio/webm,video/mp4,video/webm",
    disabled: false,
    errorMessage: null,
    file: null,
    job: null,
    onFileChange: () => undefined,
    onOpenMeeting: () => undefined,
    onSubmit: () => undefined,
    onTagsTextChange: () => undefined,
    onTitleChange: () => undefined,
    statusLabel: null,
    tagsText: "planning, research",
    title: "Discovery call",
    uploadProgress: 0,
  },
};

export default meta;

type Story = StoryObj<typeof PersonalUploadPanel>;

export const Empty: Story = {};

export const Uploading: Story = {
  args: {
    disabled: true,
    statusLabel: "Uploading media...",
    uploadProgress: 42,
  },
};

export const Queued: Story = {
  args: {
    disabled: true,
    job: { status: "queued" },
    statusLabel: "Waiting to process uploaded media...",
    uploadProgress: 100,
  },
};

export const Processing: Story = {
  args: {
    disabled: true,
    job: { status: "processing" },
    statusLabel: "Processing uploaded media...",
    uploadProgress: 100,
  },
};

export const Complete: Story = {
  args: {
    job: {
      status: "complete",
      meetingGuildId: "personal:user-1",
      channelId_timestamp: "personal#2026-01-01T00:00:00.000Z",
    },
    statusLabel: "Processing complete.",
    uploadProgress: 100,
  },
};

export const Failed: Story = {
  args: {
    job: {
      status: "failed",
      errorMessage: "Normalized audio is too large to transcribe in one pass.",
    },
    statusLabel: "Processing failed.",
    uploadProgress: 100,
  },
};
