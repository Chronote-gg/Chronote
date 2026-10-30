import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { UpgradePreview } from "../storybook/UpgradePreview";
import type { FirstMeetingState } from "../../types/firstMeeting";

const meta = {
  title: "Pages/Join",
  tags: ["first-meeting"],
  component: UpgradePreview,
  args: { path: "/join" },
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
const meeting = {
  historyId: "story-history",
  title: "Engineering weekly planning",
  portalUrl: "https://chronote.gg/portal/meetings/example/story-history",
  discordUrl: "https://discord.com/channels/example/notes/recording",
  captureNotice: "Some audio could not be captured.",
  recoveryNotice: "Recording recovered after an interruption.",
};

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
    await expect(
      canvas.getByRole("link", { name: "Open portal" }),
    ).toHaveAttribute("href", "/portal");
    await expect(canvas.getByText("Join a voice channel.")).toBeVisible();
    await expect(
      canvas.getByText("/startmeeting", { exact: true }),
    ).toBeVisible();
    await expect(
      canvas.getByText("End the recording to get your notes."),
    ).toBeVisible();
    await expect(canvas.getByTestId("sample-summary")).toBeVisible();
    await expect(
      canvas.getByText("Example notes · Fictional meeting"),
    ).toBeVisible();
    await expect(
      canvas.getByText("Optional setup").closest("details"),
    ).not.toHaveAttribute("open");
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
export const UnknownServer: Story = {
  ...FirstRecording,
  args: { path: "/join?serverId=unavailable" },
};

function progressStory(
  state: FirstMeetingState,
  heading: string,
  action: "View recording" | "Open meeting",
): Story {
  return {
    args: { path: "/join?serverId=example", firstMeetingState: state },
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await expect(
        await canvas.findByRole("heading", { name: heading }),
      ).toBeVisible();
      await expect(canvas.getByRole("link", { name: action })).toHaveAttribute(
        "href",
        action === "Open meeting"
          ? "https://chronote.gg/portal/meetings/example/story-history"
          : "https://discord.com/channels/example/notes/recording",
      );
      await expect(
        canvas.getByRole("link", { name: "Open portal" }),
      ).toHaveAttribute(
        "href",
        "/portal/meetings?scope=guild&serverId=example",
      );
      await expect(
        canvas.getByText("Some audio could not be captured."),
      ).toBeVisible();
      await expect(
        canvas.getByText("Recording recovered after an interruption."),
      ).toBeVisible();
      await expect(
        canvas.getByRole("button", { name: "Check again" }),
      ).toBeVisible();
      await expect(
        canvas.queryByRole("link", {
          name: action === "Open meeting" ? "View recording" : "Open meeting",
        }),
      ).not.toBeInTheDocument();
    },
  };
}
export const Recording = progressStory(
  { kind: "recording", meeting },
  "Recording in progress",
  "View recording",
);
export const Processing = progressStory(
  { kind: "processing", meeting },
  "Preparing your notes",
  "View recording",
);
export const Ready = progressStory(
  { kind: "ready", meeting },
  "Your notes are ready",
  "Open meeting",
);
export const SavedWithoutDelivery = progressStory(
  { kind: "saved", meeting },
  "Notes saved",
  "Open meeting",
);
export const DeliveryPartial = progressStory(
  { kind: "delivery_attention", delivery: "partial", meeting },
  "Notes saved. Some notes could not be posted to Discord.",
  "Open meeting",
);
export const DeliveryFailed = progressStory(
  { kind: "delivery_attention", delivery: "failed", meeting },
  "Notes saved. Discord delivery failed.",
  "Open meeting",
);
export const StatusUnavailable: Story = {
  args: { path: "/join?serverId=example", errorFor: "meetings.firstMeeting" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Status unavailable. Check again to refresh it."),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Check again" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("link", { name: "Open meeting" }),
    ).not.toBeInTheDocument();
  },
};
export const OptionalSetup: Story = {
  ...FirstRecording,
  args: { path: "/join?serverId=example" },
  play: async (context) => {
    const canvas = within(context.canvasElement);
    await expect(
      await canvas.findByText("No accessible recent meeting found yet."),
    ).toBeVisible();
    await userEvent.click(canvas.getByText("Optional setup"));
    await expect(
      canvas.getByText("Optional setup").closest("details"),
    ).toHaveAttribute("open");
    await expect(canvas.getByText("/context", { exact: true })).toBeVisible();
    await expect(
      canvas.getByText("/autorecord", { exact: true }),
    ).toBeVisible();
  },
};
export const ReadyLight: Story = {
  ...Ready,
  args: { ...Ready.args, colorScheme: "light" },
};
export const DeliveryPartialLight: Story = {
  ...DeliveryPartial,
  args: { ...DeliveryPartial.args, colorScheme: "light" },
};
export const OptionalSetupLight: Story = {
  ...OptionalSetup,
  args: { ...OptionalSetup.args, colorScheme: "light" },
};
export const FirstRecordingMobile: Story = { ...FirstRecording };
export const FirstRecordingTablet: Story = { ...FirstRecording };
