import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { notifications } from "@mantine/notifications";
import { TRPCClientError } from "@trpc/client";
import { showBillingError } from "./billingErrorNotification";

function BillingErrorExample({
  code,
  message,
  action,
}: {
  code: string;
  message: string;
  action: "checkout" | "portal";
}) {
  useEffect(() => {
    notifications.clean();
    showBillingError(
      new TRPCClientError(message, {
        result: { error: { code: -32003, message, data: { code } } },
      }),
      action,
    );
    return () => notifications.clean();
  }, [code, message, action]);
  return <div style={{ minHeight: 220 }} />;
}

const meta: Meta<typeof BillingErrorExample> = {
  title: "Billing/ErrorNotification",
  tags: ["billing-errors"],
  component: BillingErrorExample,
  args: {
    action: "checkout",
    code: "FORBIDDEN",
    message: "Only the original payer can manage this server's Stripe billing",
  },
};
export default meta;
type Story = StoryObj<typeof BillingErrorExample>;
export const PayerRequired: Story = {};
export const SubscriptionRecovery: Story = {
  args: {
    code: "BAD_REQUEST",
    message:
      "Resolve the existing subscription in billing management before changing plans",
  },
};
export const PortalPayerRequired: Story = { args: { action: "portal" } };
export const TransitionsDisabled: Story = {
  args: {
    code: "BAD_REQUEST",
    message:
      "Plan changes are not available yet. Your current subscription is unchanged; contact support for help.",
  },
};
export const UnexpectedFailure: Story = {
  args: {
    code: "INTERNAL_SERVER_ERROR",
    message: "promotion provider internal details",
  },
};
