import type { Meta, StoryObj } from "@storybook/react";
import {
  RetainedRecordingCard,
  type RetainedRecording,
} from "../../../../apps/desktop/src/RetainedRecordingCard";

const retained = {
  recordingId: "original-recording",
  startedAt: "2026-06-15T12:00:00.000Z",
  stoppedAt: "2026-06-15T12:10:00.000Z",
  retainedAt: "2026-06-15T12:10:00.000Z",
  title: "Saved planning call",
  tags: ["planning"],
  status: "paused",
  errorMessage:
    "This draft is preserved and paused. Recovery is not available yet.",
  localPath: "C:\\Recordings\\original-recording",
  sources: [
    {
      sourceId: "owner_mic",
      kind: "owner_mic",
      label: "Me",
      fileSize: 1048576,
      segmentCount: 10,
      uploadedSegmentCount: 8,
    },
  ],
} satisfies RetainedRecording;

const meta: Meta<typeof RetainedRecordingCard> = {
  title: "Desktop/RetainedRecordingCard",
  component: RetainedRecordingCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 360, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
  args: {
    busy: false,
    isRecording: false,
    runningAction: null,
    onRetry: () => undefined,
    onOpen: () => undefined,
    onDelete: () => undefined,
    retained,
  },
};

export default meta;
type Story = StoryObj<typeof RetainedRecordingCard>;
export const Paused = {
  tags: ["paused-draft"],
  args: { retained },
} satisfies Story;
export const PausedMobile: Story = {
  ...Paused,
  tags: ["paused-draft"],
  args: {
    ...Paused.args,
    retained: {
      ...Paused.args.retained,
      title:
        "Saved planning call about next quarter's research and release schedule",
      localPath:
        "C:\\Users\\Visual Tester\\AppData\\Roaming\\gg.chronote.desktop\\recordings\\2026-06-15T12-00-00-original-recording-00000000-0000-4000-8000-000000000001",
    },
  },
};
