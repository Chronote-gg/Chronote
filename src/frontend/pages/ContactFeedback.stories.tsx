import type { Meta, StoryObj } from "@storybook/react";
import { ContactFeedbackForm } from "./ContactFeedback";

const meta: Meta<typeof ContactFeedbackForm> = {
  title: "Pages/ContactFeedbackForm",
  component: ContactFeedbackForm,
  args: {
    isAnonymous: true,
    isPending: false,
    submitError: null,
    onSubmit: () => {},
  },
};

export default meta;

type Story = StoryObj<typeof ContactFeedbackForm>;

export const Anonymous: Story = {};

export const Authenticated: Story = {
  args: {
    isAnonymous: false,
  },
};

export const Submitting: Story = {
  args: {
    isPending: true,
  },
};

export const WithError: Story = {
  args: {
    submitError: { message: "Too many submissions. Please try again later." },
  },
};
