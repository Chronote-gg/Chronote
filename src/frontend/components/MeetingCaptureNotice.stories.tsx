import type { Meta, StoryObj } from "@storybook/react";
import { MeetingCaptureNotice } from "./MeetingCaptureNotice";
const meta: Meta<typeof MeetingCaptureNotice> = {
  title: "Meetings/CaptureNotice",
  tags: ["recording-outcomes"],
  component: MeetingCaptureNotice,
  args: {
    capture: {
      kind: "interrupted",
      startedAt: "2026-01-01T00:00:00Z",
      detectedAt: "2026-01-01T01:00:00Z",
      endedAt: null,
    },
    notes: "Generated saved decision.",
  },
};
export default meta;
type Story = StoryObj<typeof MeetingCaptureNotice>;
export const UnknownCoverage: Story = {};
export const VerifiedCoverage: Story = {
  args: {
    captureCoverage: {
      kind: "verified",
      savedDurationMs: 42500,
      lastConfirmedCaptureAt: "2026-01-01T00:00:43Z",
    },
    recoveryNotice: "Saved recording recovery finished.",
  },
};
export const RecoveryPending: Story = {
  args: { recoveryNotice: "Recovering saved recording." },
};
export const RecoveryNeedsReview: Story = {
  args: {
    recoveryNotice:
      "Recovery needs review. Processing or delivery could not be confirmed.",
  },
};
