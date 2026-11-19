import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, within } from "storybook/test";
import MeetingTimeline, { MEETING_TIMELINE_FILTERS } from "./MeetingTimeline";
import type { MeetingEvent } from "../../types/meetingTimeline";

const events: MeetingEvent[] = [
  {
    id: "event-1",
    type: "voice",
    time: "7:43",
    speaker: "Speaker A",
    text: "I think I have a good idea for a new class.",
  },
  {
    id: "event-2",
    type: "presence",
    time: "8:59",
    speaker: "Participant B",
    text: "joined the channel",
  },
  {
    id: "event-3",
    type: "chat",
    time: "9:32",
    speaker: "Participant C",
    text: "Hello, hello.",
    attachments: [
      {
        id: "att-1",
        name: "diagram.png",
        size: 48231,
        url: "https://cdn.discordapp.com/attachments/mock/diagram.png",
        contentType: "image/png",
        width: 1024,
        height: 768,
      },
      {
        id: "att-2",
        name: "notes.pdf",
        size: 173920,
        url: "https://cdn.discordapp.com/attachments/mock/notes.pdf",
        contentType: "application/pdf",
      },
    ],
  },
  {
    id: "event-4",
    type: "tts",
    time: "10:06",
    speaker: "Speaker A",
    text: "I have a good idea of what I want to do.",
  },
  {
    id: "event-5",
    type: "bot",
    time: "10:22",
    text: "Note created for this meeting.",
  },
];

const meta: Meta<typeof MeetingTimeline> = {
  title: "Components/MeetingTimeline",
  component: MeetingTimeline,
  args: {
    events,
    activeFilters: MEETING_TIMELINE_FILTERS.map((filter) => filter.value),
    height: 320,
    emptyLabel: "No transcript activity yet.",
  },
};

export default meta;

type Story = StoryObj<typeof MeetingTimeline>;

export const Default: Story = {
  render: (args) => <MeetingTimeline {...args} />,
};

export const PlaybackMobile: Story = {
  tags: ["transcript-playback"],
  args: {
    events: [{ ...events[0], offsetSeconds: 463 }, ...events.slice(1)],
    onPlayFrom: fn(),
    playbackEventId: "event-1",
  },
  play: async ({ args, canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const buttons = canvas.getAllByRole("button", { name: /Play from here/ });
    await expect(buttons).toHaveLength(1);
    const [play] = buttons;
    await userEvent.click(canvas.getByText(events[0].text));
    await expect(args.onPlayFrom).not.toHaveBeenCalled();
    play.focus();
    await expect(
      await within(document.body).findByRole("tooltip"),
    ).toHaveTextContent("Play from here");
    await userEvent.keyboard("{Enter}");
    await expect(args.onPlayFrom).toHaveBeenCalledWith(463);
    play.blur();
  },
};
