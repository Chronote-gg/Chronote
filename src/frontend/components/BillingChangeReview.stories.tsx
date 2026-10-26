import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import {
  Alert,
  Badge,
  Button,
  Container,
  Group,
  Modal,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { expect, userEvent, within } from "storybook/test";
import Surface from "./Surface";
import BillingChangeReview, {
  type BillingChangeReviewQuote,
  type BillingChangeReviewStatus,
} from "./BillingChangeReview";

const pro: BillingChangeReviewQuote = {
  serverName: "Engineering HQ",
  targetTier: "pro",
  interval: "month",
  timing: "immediate",
  effectiveAt: "2026-10-29T12:00:00Z",
  currency: "usd",
  chargeLabel: "Pro for the rest of this billing period",
  chargePeriod: "Oct 29 to Nov 14, 2026",
  creditLabel: "Credit for unused Basic time",
  planCharge: 1200,
  offerSavings: 0,
  unusedCredit: 300,
  taxAmount: 0,
  taxTreatment: "added",
  billingBalance: 0,
  amountDue: 900,
  remainingCredit: 0,
  nextPlanRate: 2400,
  nextAt: "2026-11-14T12:00:00Z",
  offerTerms: null,
  endingOffer: "monthly",
};
const annual: BillingChangeReviewQuote = {
  ...pro,
  targetTier: "basic",
  interval: "year",
  chargeLabel: "Basic for one year",
  chargePeriod: "Oct 29, 2026 to Oct 29, 2027",
  planCharge: 10000,
  offerSavings: 4000,
  amountDue: 5700,
  nextPlanRate: 10000,
  nextAt: "2027-10-29T12:00:00Z",
  offerTerms: "$60 for your first year, then $100/year.",
};
const monthly: BillingChangeReviewQuote = {
  ...pro,
  targetTier: "basic",
  interval: "month",
  timing: "renewal",
  effectiveAt: "2027-10-14T12:00:00Z",
  planCharge: 1000,
  offerSavings: 400,
  unusedCredit: 0,
  amountDue: 0,
  nextPlanRate: 600,
  nextAt: "2027-10-14T12:00:00Z",
  offerTerms: "$6/month for 3 months, then $10/month.",
  endingOffer: null,
};

function Preview({
  quote = pro,
  decline = false,
  currentPlan = "Basic monthly",
  initialStatus = "review",
  cancellationUnknown = false,
}: {
  quote?: BillingChangeReviewQuote;
  decline?: boolean;
  currentPlan?: string;
  initialStatus?: BillingChangeReviewStatus;
  cancellationUnknown?: boolean;
}) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] =
    useState<BillingChangeReviewStatus>(initialStatus);
  const [reviewedQuote, setReviewedQuote] = useState(quote);
  const [outcome, setOutcome] = useState<
    "applied" | "scheduled" | "canceled" | null
  >(null);
  const [applied, setApplied] = useState(false);
  const finish = () => {
    setApplied(reviewedQuote.timing === "immediate");
    setOutcome(reviewedQuote.timing === "renewal" ? "scheduled" : "applied");
    setOpen(false);
  };
  const confirm = () => {
    if (decline) setStatus("payment_required");
    else finish();
  };
  const canceled = () => {
    setStatus("review");
    setOutcome("canceled");
    setOpen(false);
  };
  const cancel = () => {
    if (status === "processing" || status === "cancellation_unknown") return;
    if (cancellationUnknown && status === "payment_required")
      setStatus("cancellation_unknown");
    else canceled();
  };
  const locked = status === "processing" || status === "cancellation_unknown";
  return (
    <Container size={760} py="xl">
      <Stack gap="lg">
        <Group>
          <Title order={2}>Billing</Title>
          <Badge color="gray">Design preview</Badge>
        </Group>
        <Text size="sm" c="dimmed">
          Synthetic quotes and payments. These controls make no billing
          requests.
        </Text>
        <Surface p="xl">
          <Stack>
            <Text fw={600}>Current plan</Text>
            <Title order={3}>
              {applied
                ? reviewedQuote.targetTier === "pro"
                  ? "Pro"
                  : "Basic"
                : currentPlan}
            </Title>
            <Text>{reviewedQuote.serverName}</Text>
          </Stack>
        </Surface>
        {outcome === "scheduled" && (
          <Alert title="Plan change scheduled" color="brand">
            Your current plan stays active until the change takes effect.
            <Group mt="sm">
              <Button
                size="sm"
                onClick={() => {
                  setOutcome(null);
                  setOpen(true);
                }}
              >
                Edit change
              </Button>
              <Button size="sm" variant="subtle" onClick={cancel}>
                Cancel change
              </Button>
            </Group>
          </Alert>
        )}
        {outcome === "applied" && (
          <Alert title="Plan changed" color="teal">
            Your new plan is active.
          </Alert>
        )}
        {outcome === "canceled" && (
          <Alert title="Change canceled" color="gray">
            Your current plan is unchanged.
          </Alert>
        )}
        <Button
          onClick={() => {
            setOutcome(null);
            setStatus(initialStatus);
            setOpen(true);
          }}
        >
          Review plan change
        </Button>
      </Stack>
      <Modal
        opened={open}
        onClose={cancel}
        title="Review plan change"
        centered
        size="md"
        closeOnEscape={!locked}
        closeOnClickOutside={!locked}
        withCloseButton={!locked}
      >
        <BillingChangeReview
          quote={reviewedQuote}
          status={status}
          onConfirm={confirm}
          onBack={cancel}
          onContinuePayment={finish}
          onChangeSelection={() => {
            setStatus("review");
            setOpen(false);
          }}
          onRefreshQuote={() => {
            setReviewedQuote({
              ...reviewedQuote,
              unusedCredit: 200,
              amountDue: reviewedQuote.amountDue + 100,
            });
            setStatus("review");
          }}
          onCheckStatus={canceled}
        />
      </Modal>
    </Container>
  );
}
const meta = {
  title: "Billing/Plan changes",
  tags: ["integration-plan-changes"],
  component: Preview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const BasicMonthlyToPro: Story = {};
export const BasicMonthlyToAnnual: Story = { args: { quote: annual } };
export const AnnualToMonthlyAtRenewal: Story = {
  args: { quote: monthly, currentPlan: "Basic annual" },
};
export const ReturnToUsedMonthlyOffer: Story = {
  args: {
    quote: {
      ...monthly,
      effectiveAt: "2026-11-14T12:00:00Z",
      nextAt: "2026-11-14T12:00:00Z",
      offerSavings: 0,
      nextPlanRate: 1000,
      offerTerms: null,
    },
    currentPlan: "Pro monthly",
  },
};
export const CreditCoversAnnual: Story = {
  args: { quote: { ...annual, billingBalance: -5700, amountDue: 0 } },
};
export const AnnualWithPreviousBalance: Story = {
  tags: ["previous-balance"],
  args: { quote: { ...annual, billingBalance: 500, amountDue: 6200 } },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(
      screen.getByText("Previous balance", { exact: true }),
    ).toBeVisible();
    await expect(screen.getByText("$5", { exact: true })).toBeVisible();
    await expect(
      screen.getByRole("button", { name: "Confirm and pay $62", exact: true }),
    ).toBeVisible();
  },
};
export const AnnualWithTax: Story = {
  args: {
    quote: { ...annual, taxAmount: 456, amountDue: 6156, nextPlanRate: 10000 },
  },
};
export const ExcessBillingCredit: Story = {
  args: {
    quote: {
      ...annual,
      billingBalance: -5700,
      amountDue: 0,
      remainingCredit: 3000,
    },
  },
};
export const PaidToFreeAtRenewal: Story = {
  args: {
    quote: {
      ...monthly,
      targetTier: "free",
      nextPlanRate: null,
      nextAt: null,
      offerTerms: null,
    },
    currentPlan: "Pro annual",
  },
};
export const ChangedQuoteNeedsReview: Story = {
  args: { quote: annual, initialStatus: "quote_changed" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await expect(
      screen.queryByRole("button", { name: /^Confirm and pay/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Review updated total" }),
    );
    await expect(
      screen.getByRole("button", { name: "Confirm and pay $58" }),
    ).toBeVisible();
  },
};
export const ProcessingCannotBeDismissed: Story = {
  args: { initialStatus: "processing" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.keyboard("{Escape}");
    await expect(screen.getByRole("dialog")).toBeVisible();
    await expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
    await expect(
      screen.getByRole("button", { name: "Check status" }),
    ).toBeEnabled();
  },
};
export const CancellationNeedsVerification: Story = {
  args: { initialStatus: "payment_required", cancellationUnknown: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel change" }),
    );
    await expect(screen.getByText("Cancellation not confirmed")).toBeVisible();
    await expect(
      screen.queryByRole("button", { name: "Continue payment" }),
    ).not.toBeInTheDocument();
  },
};
export const PaymentNeedsAttention: Story = {
  args: { decline: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      screen.getByRole("button", { name: /^Confirm and pay/ }),
    );
    await expect(
      screen.getByText("Complete payment", { exact: true }),
    ).toBeVisible();
    await expect(
      screen.getByRole("heading", { name: /^Basic monthly$/ }),
    ).toBeVisible();
  },
};
export const ScheduledChangeCanBeCanceled: Story = {
  args: { quote: monthly, currentPlan: "Basic annual" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      screen.getByRole("button", { name: "Schedule change" }),
    );
    await expect(screen.getByText("Plan change scheduled")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel change" }),
    );
    await expect(screen.getByText("Change canceled")).toBeVisible();
    await expect(
      screen.getByRole("heading", { name: /^Basic annual$/ }),
    ).toBeVisible();
  },
};

export const AnnualTaxIncluded: Story = {
  args: { quote: { ...annual, taxAmount: 456, taxTreatment: "included" } },
};
