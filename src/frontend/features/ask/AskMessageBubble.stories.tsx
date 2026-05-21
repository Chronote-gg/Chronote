import type { Meta, StoryObj } from "@storybook/react";
import { AskMessageBubble } from "./AskMessageBubble";
import type { AskMessage } from "../../../types/ask";

const baseMessage: AskMessage = {
  id: "m1",
  role: "chronote",
  text: "Summary highlights:\n- Budget approved\n- Launch on Feb 2",
  createdAt: "2026-01-03T18:30:00.000Z",
};

const meta: Meta<typeof AskMessageBubble> = {
  title: "Ask/MessageBubble",
  component: AskMessageBubble,
  args: {
    message: baseMessage,
    roleLabels: { user: "You", chronote: "Chronote" },
    highlighted: false,
    showActions: true,
  },
};

export default meta;

type Story = StoryObj<typeof AskMessageBubble>;

export const Chronote: Story = {};

export const User: Story = {
  args: {
    message: {
      ...baseMessage,
      id: "m2",
      role: "user",
      text: "What did we decide?",
    },
  },
};

export const Highlighted: Story = {
  args: {
    highlighted: true,
  },
};

export const WithCitations: Story = {
  args: {
    message: {
      ...baseMessage,
      text: "Decision recap with citations. [1](https://chronote.test/portal/meetings/server-1/meeting-1)",
    },
  },
};
