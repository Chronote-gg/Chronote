import type { Meta, StoryObj } from "@storybook/react";
import { expect, within } from "storybook/test";
import { Box, Stack } from "@mantine/core";
import CheckoutRecovery, { IntroOfferAvailability } from "./CheckoutRecovery";
import type { BasicIntroOffer } from "../../types/pricing";

function Preview({
  offer,
  checkoutFailed,
}: {
  offer: BasicIntroOffer;
  checkoutFailed: boolean;
}) {
  return (
    <Box p="md" maw={700}>
      <Stack gap="md">
        <IntroOfferAvailability offer={offer} />
        <CheckoutRecovery
          offer={offer}
          checkoutFailed={checkoutFailed}
          retryDisabled={false}
          refreshDisabled={false}
          onRetry={() => undefined}
          onRefresh={() => undefined}
        />
      </Stack>
    </Box>
  );
}
const meta = {
  title: "Billing/Checkout recovery",
  component: Preview,
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const IntroPricingUnavailable: Story = {
  args: { offer: { status: "unavailable" }, checkoutFailed: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/could not be confirmed right now/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Refresh offers" }),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Retry checkout" }),
    ).toBeNull();
  },
};
export const CheckoutFailed: Story = {
  args: { offer: { status: "ineligible" }, checkoutFailed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(/Checkout could not be opened/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Retry checkout" }),
    ).toBeVisible();
  },
};
export const CheckoutFailedWhileIntroUnavailable: Story = {
  args: { offer: { status: "unavailable" }, checkoutFailed: true },
};
