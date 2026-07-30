import type { Meta, StoryObj } from "@storybook/react";
import { SampleSummary } from "./SampleSummary";

const meta: Meta<typeof SampleSummary> = {
  title: "Components/SampleSummary",
  component: SampleSummary,
};

export default meta;

type Story = StoryObj<typeof SampleSummary>;

export const Default: Story = {};
