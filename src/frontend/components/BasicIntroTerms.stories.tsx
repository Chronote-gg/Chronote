import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import BasicIntroTerms from "./BasicIntroTerms";
import { monthlyIntroOffer } from "../pages/basicIntroFixtures";

const cutoff = new Date("2026-11-02T17:15:30.000Z");
const meta: Meta<typeof BasicIntroTerms> = {
  title: "Billing/Introductory terms",
  component: BasicIntroTerms,
  tags: ["integration-offer-deadline"],
  args: {
    offer: { ...monthlyIntroOffer, enrollmentEndsAt: cutoff.toISOString() },
  },
};
export default meta;
type Story = StoryObj<typeof meta>;

export const ExactDeadline: Story = {
  play: async ({ canvasElement }) => {
    const deadline = within(canvasElement).getByText(/^Enroll by/);
    await expect(deadline).toHaveTextContent(/\d+:\d{2}:\d{2}/);
    const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
      .formatToParts(cutoff)
      .find((part) => part.type === "timeZoneName")!.value;
    await expect(deadline).toHaveTextContent(zone);
  },
};
