import type { Meta, StoryObj } from "@storybook/react";
import { MeetingAudioPanel } from "./MeetingAudioPanel";

const meta: Meta<typeof MeetingAudioPanel> = {
  title: "Library/MeetingAudioPanel",
  component: MeetingAudioPanel,
  args: {
    audioUrl: null,
  },
};

export default meta;

type Story = StoryObj<typeof MeetingAudioPanel>;

export const NoAudio: Story = {};

export const WithAudio: Story = {
  args: {
    audioUrl: "/audio/sample.mp3",
  },
};

export const AccessDisabled: Story = {
  args: {
    accessEnabled: false,
    audioUrl: "/audio/sample.mp3",
  },
};
