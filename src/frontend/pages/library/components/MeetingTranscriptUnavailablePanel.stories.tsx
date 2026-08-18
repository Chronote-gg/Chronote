import type { Meta, StoryObj } from "@storybook/react";
import { MeetingTranscriptUnavailablePanel } from "./MeetingTranscriptUnavailablePanel";

const meta: Meta<typeof MeetingTranscriptUnavailablePanel> = {
  title: "Library/MeetingTranscriptUnavailablePanel",
  component: MeetingTranscriptUnavailablePanel,
};

export default meta;

type Story = StoryObj<typeof MeetingTranscriptUnavailablePanel>;

export const Default: Story = {};
