import type { Meta, StoryObj } from "@storybook/react";
import {
  RecorderPanel,
  type RecorderPanelProps,
  type SourceSignal,
} from "../../../../apps/desktop/src/RecorderPanel";
import "../../../../apps/desktop/src/styles.css";

const readySignals: SourceSignal[] = [
  {
    id: "mic",
    label: "Mic",
    detail: "USB Podcast Mic",
    level: null,
    status: "ready",
  },
  {
    id: "system",
    label: "System/Other",
    detail: "Studio Headphones",
    level: null,
    status: "ready",
  },
];

const noop = () => undefined;

const baseArgs = {
  busy: false,
  error: null,
  isRecording: false,
  message: null,
  sourceSignals: readySignals,
  tags: "desktop, ux",
  title: "Design review",
  onStartRecording: noop,
  onStopAndUpload: noop,
  onTagsChange: noop,
  onTitleChange: noop,
} satisfies RecorderPanelProps;

const meta: Meta<typeof RecorderPanel> = {
  title: "Desktop/RecorderPanel",
  component: RecorderPanel,
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <main className="app-shell">
        <Story />
      </main>
    ),
  ],
  args: baseArgs,
};

export default meta;

type Story = StoryObj<typeof RecorderPanel>;

export const Ready: Story = {};

export const RecordingWithLevels: Story = {
  args: {
    isRecording: true,
    message: "Recording started.",
    sourceSignals: [
      {
        id: "mic",
        label: "Mic",
        detail: "USB Podcast Mic",
        level: 0.76,
        status: "recording",
      },
      {
        id: "system",
        label: "System/Other",
        detail: "Studio Headphones",
        level: 0.42,
        status: "recording",
      },
    ],
    startedAt: "2026-06-08T02:12:40.000Z",
  },
};

export const CheckingForSignal: Story = {
  args: {
    isRecording: true,
    sourceSignals: [
      {
        id: "mic",
        label: "Mic",
        detail: "USB Podcast Mic",
        level: null,
        status: "checking",
      },
      {
        id: "system",
        label: "System/Other",
        detail: "Studio Headphones",
        level: null,
        status: "checking",
      },
    ],
    startedAt: "2026-06-08T02:12:40.000Z",
  },
};

export const SilentMic: Story = {
  args: {
    isRecording: true,
    sourceSignals: [
      {
        id: "mic",
        label: "Mic",
        detail: "USB Podcast Mic",
        level: 0.02,
        status: "silent",
      },
      {
        id: "system",
        label: "System/Other",
        detail: "Studio Headphones",
        level: 0.58,
        status: "recording",
      },
    ],
    startedAt: "2026-06-08T02:12:40.000Z",
  },
};

export const UnavailableSystemAudio: Story = {
  args: {
    error: "System output is unavailable. Choose another output in settings.",
    sourceSignals: [
      readySignals[0],
      {
        id: "system",
        label: "System/Other",
        detail: "No output device found",
        level: null,
        status: "unavailable",
      },
    ],
  },
};

export const CompactRecording: Story = {
  args: {
    ...RecordingWithLevels.args,
    tags: "standup",
    title: "Daily sync",
    variant: "compact",
  },
};
