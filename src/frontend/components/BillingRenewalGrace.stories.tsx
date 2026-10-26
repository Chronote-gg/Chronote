import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Box } from "@mantine/core";
import BillingRenewalGrace from "./BillingRenewalGrace";
import { renewalGraceFixture } from "../pages/renewalGraceFixtures";
import type { RenewalRecoveryView } from "../../types/renewalRecovery";

function Preview({ initialView }: { initialView: RenewalRecoveryView }) {
  const [view, setView] = useState(initialView);
  return (
    <Box p="md" maw={700}>
      <BillingRenewalGrace
        serverName="Engineering HQ"
        onUpdatePaymentMethod={() => undefined}
        recovery={{
          view,
          busy: false,
          error: null,
          pending: view.status !== "none" && view.status !== "canceled",
          refresh: async () => undefined,
          cancel: async () => {
            if (view.status !== "none")
              setView({ ...view, status: "canceled", paymentUrl: null });
          },
        }}
      />
    </Box>
  );
}
const meta = {
  title: "Billing/Renewal grace",
  component: Preview,
  tags: ["renewal-grace"],
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BasicRenewal: Story = {
  args: { initialView: renewalGraceFixture() },
};
export const ProRenewal: Story = {
  args: {
    initialView: renewalGraceFixture({
      priorTier: "pro",
      selectedTier: "pro",
      selectedInterval: "year",
      amountDue: 24000,
    }),
  },
};
export const ScheduledDowngrade: Story = {
  args: {
    initialView: renewalGraceFixture({
      priorTier: "pro",
      selectedTier: "basic",
      scheduledChange: true,
    }),
  },
};
export const CancellationConfirmation: Story = {
  ...ScheduledDowngrade,
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Cancel renewal" }),
    );
    await waitFor(() =>
      expect(
        within(document.body).getByRole("dialog", {
          name: "Cancel this renewal?",
        }),
      ).toBeVisible(),
    );
  },
};
export const Canceled: Story = {
  args: {
    initialView: renewalGraceFixture({
      status: "canceled",
      priorTier: "pro",
      scheduledChange: true,
      paymentUrl: null,
    }),
  },
};
export const PaymentProcessing: Story = {
  args: {
    initialView: renewalGraceFixture({
      status: "settlement_pending",
      paymentUrl: null,
    }),
  },
};
export const TerminalInvoice: Story = {
  tags: ["terminal-renewal"],
  args: {
    initialView: renewalGraceFixture({ paymentUrl: null, amountDue: null }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("link", { name: "Retry payment" }),
    ).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Cancel renewal" }),
    ).toBeEnabled();
  },
};
export const TerminalInvoiceMobile: Story = {
  tags: ["terminal-renewal"],
  ...TerminalInvoice,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
export const CleanupPending: Story = {
  args: {
    initialView: renewalGraceFixture({
      status: "reconciling",
      paymentUrl: null,
    }),
  },
};
export const Expired: Story = {
  args: {
    initialView: renewalGraceFixture({
      status: "canceled",
      endsAt: "2025-01-01T00:00:00.000Z",
      paymentUrl: null,
    }),
  },
};
export const OtherManager: Story = {
  args: {
    initialView: renewalGraceFixture({ canManage: false, paymentUrl: null }),
  },
};
export const ScheduledDowngradeMobile: Story = {
  ...ScheduledDowngrade,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
