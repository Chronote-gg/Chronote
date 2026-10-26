import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { Box, Stack, Text } from "@mantine/core";
import BillingRenewalStatus from "./BillingRenewalStatus";
import BillingPaymentHistory from "./BillingPaymentHistory";
import Surface from "./Surface";
import type { RenewalState, RenewalTerms } from "../../types/renewal";
const terms: RenewalTerms = {
  tier: "basic",
  interval: "year",
  currency: "usd",
  unitAmount: 10000,
  taxBehavior: "exclusive",
  renewsAt: "2027-10-12T12:00:00.000Z",
  discount: null,
};
function Preview({
  initialState,
  canManageBilling = true,
}: {
  initialState: RenewalState;
  canManageBilling?: boolean;
}) {
  const [state, setState] = useState(initialState);
  return (
    <Box maw={650} p="md">
      <Stack gap="md">
        <Surface p="xl">
          <Stack gap="md">
            <Text fw={600}>Current plan</Text>
            <Text size="lg" fw={700}>
              Basic
            </Text>
            <Text size="sm" c="dimmed">
              Engineering HQ
            </Text>
            <BillingRenewalStatus
              state={state}
              canManageBilling={canManageBilling}
              busy={false}
              onConfirm={() =>
                setState({
                  kind: "processing",
                  operationId: "storybook-operation",
                  endsAt: terms.renewsAt,
                })
              }
              onCheckStatus={() => setState({ kind: "on", terms })}
              onRetry={() => setState(initialState)}
              onPortal={() => undefined}
            />
          </Stack>
        </Surface>
        <Surface p="md">
          <BillingPaymentHistory
            firstYearPayment={{
              status: "available",
              currency: "usd",
              discountedSubtotal: 6000,
              amountPaid: 6420,
              periodStartsAt: "2026-10-12T12:00:00.000Z",
              periodEndsAt: terms.renewsAt,
            }}
            previousStatus="active"
            canViewReceipts={canManageBilling}
            onViewReceipts={() => undefined}
            busy={false}
          />
        </Surface>
      </Stack>
    </Box>
  );
}
const off: RenewalState = {
  kind: "off",
  tier: "basic",
  endsAt: terms.renewsAt,
  action: {
    kind: "ready",
    quoteToken: "synthetic-storybook-consent",
    expiresAt: Date.parse("2027-10-12T11:59:00Z"),
    terms,
  },
};
const meta: Meta<typeof Preview> = {
  title: "Billing/Renewal",
  component: Preview,
  tags: ["renewal"],
  args: { initialState: off },
};
export default meta;
type Story = StoryObj<typeof meta>;
export const RenewalOff: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await expect(c.getByText("Renewal off")).toBeVisible();
    await expect(
      c.getByRole("button", { name: "Turn renewal back on" }),
    ).toBeEnabled();
    await expect(c.getByText(/\$64.20 paid/)).not.toBeVisible();
  },
};
export const RenewalOn: Story = {
  args: { initialState: { kind: "on", terms } },
};
export const Confirmation: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole("button", { name: "Turn renewal back on" }),
    );
    await expect(c.getByText("Checking renewal")).toBeVisible();
    await userEvent.click(c.getByRole("button", { name: "Check status" }));
    await expect(c.getByText(/Renews October 12, 2027 at/)).toBeVisible();
  },
};
export const Processing: Story = {
  args: {
    initialState: {
      kind: "processing",
      operationId: "storybook-operation",
      endsAt: terms.renewsAt,
    },
  },
};
export const ReadFailure: Story = {
  args: { initialState: { kind: "unavailable", knownEndsAt: terms.renewsAt } },
};
export const NeedsReview: Story = {
  args: {
    initialState: {
      kind: "needs_review",
      operationId: "storybook-operation",
      knownEndsAt: terms.renewsAt,
    },
  },
};
export const Nonpayer: Story = { args: { canManageBilling: false } };
export const PaymentProblem: Story = {
  args: {
    initialState: {
      ...off,
      action: { kind: "review_in_stripe", reason: "payment_problem" },
    },
  },
};
export const UnsupportedSchedule: Story = {
  args: {
    initialState: {
      ...off,
      action: { kind: "review_in_stripe", reason: "unsupported_state" },
    },
  },
};
export const HistoryOpen: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Payment history" }));
    await waitFor(() => expect(c.getByText(/\$64.20 paid/)).toBeVisible());
  },
};
export const InclusiveRemainingDiscount: Story = {
  args: {
    initialState: {
      ...off,
      action: {
        kind: "ready",
        quoteToken: "synthetic-storybook-consent",
        expiresAt: Date.parse("2027-10-12T11:59:00Z"),
        terms: {
          ...terms,
          interval: "month",
          unitAmount: 600,
          taxBehavior: "inclusive",
          discount: {
            endsAt: "2027-12-12T12:00:00.000Z",
            regularUnitAmount: 1000,
          },
        },
      },
    },
  },
};
export const FailedRenewal: Story = {
  args: { initialState: { kind: "payment_problem" } },
};
export const FailedRenewalNonpayer: Story = {
  args: { initialState: { kind: "payment_problem" }, canManageBilling: false },
};
