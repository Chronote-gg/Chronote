import QuoteAmounts from "./BillingChangeAmounts";
import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import { formatCurrency } from "../utils/pricing";

export type BillingChangeReviewQuote = {
  serverName: string;
  targetTier: PaidTier | "free";
  interval: BillingInterval;
  effectiveAt: string;
  timing: "immediate" | "renewal";
  currency: string;
  chargeLabel: string;
  chargePeriod: string | null;
  creditLabel: string;
  planCharge: number;
  offerSavings: number;
  unusedCredit: number;
  taxAmount: number;
  taxTreatment: "added" | "included";
  // Positive means an amount owed; negative means available credit applied.
  billingBalance: number;
  amountDue: number;
  remainingCredit: number;
  balanceCarriedForward?: number;
  // Base plan rate before added tax or account credit.
  nextPlanRate: number | null;
  nextAt: string | null;
  offerTerms: string | null;
  endingOffer: "monthly" | "annual" | null;
};
// quote_changed is pre-charge only. Unknown provider outcomes remain processing.
export type BillingChangeReviewStatus =
  | "review"
  | "payment_required"
  | "processing"
  | "quote_changed"
  | "cancellation_unknown";
type Props = {
  quote: BillingChangeReviewQuote;
  status?: BillingChangeReviewStatus;
  onConfirm: () => void;
  onBack: () => void;
  onContinuePayment: () => void;
  onChangeSelection: () => void;
  onRefreshQuote: () => void;
  onCheckStatus: () => void;
};
const planName = { basic: "Basic", pro: "Pro", free: "Free" };
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
function ReviewActions({
  quote,
  status,
  onConfirm,
  onBack,
  onContinuePayment,
  onChangeSelection,
  onRefreshQuote,
  onCheckStatus,
}: Props & { status: BillingChangeReviewStatus }) {
  if (status === "processing")
    return (
      <Button variant="light" onClick={onCheckStatus}>
        Check status
      </Button>
    );
  if (status === "cancellation_unknown")
    return <Button onClick={onCheckStatus}>Check status</Button>;
  if (status === "quote_changed")
    return (
      <Group justify="flex-end">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onRefreshQuote}>Review updated total</Button>
      </Group>
    );
  if (status === "payment_required")
    return (
      <Group justify="flex-end" wrap="wrap">
        <Button variant="subtle" onClick={onBack}>
          Cancel change
        </Button>
        <Button variant="light" onClick={onChangeSelection}>
          Change selection
        </Button>
        <Button onClick={onContinuePayment}>Continue payment</Button>
      </Group>
    );
  const label =
    quote.timing === "renewal"
      ? "Schedule change"
      : quote.amountDue > 0
        ? "Confirm and pay " + formatCurrency(quote.amountDue, quote.currency)
        : "Confirm change";
  return (
    <Group justify="flex-end" wrap="wrap">
      <Button variant="subtle" onClick={onBack}>
        Back
      </Button>
      <Button onClick={onConfirm}>{label}</Button>
    </Group>
  );
}
export default function BillingChangeReview(props: Props) {
  const { quote, status = "review" } = props;
  const scheduled = quote.timing === "renewal";
  return (
    <Stack gap="lg" data-testid="billing-change-review">
      <Stack gap={4}>
        <Title order={3}>Change to {planName[quote.targetTier]}</Title>
        <Text size="sm" c="dimmed">
          {quote.serverName}
        </Text>
        <Text size="sm">
          {scheduled
            ? "Starts " + date(quote.effectiveAt)
            : quote.amountDue === 0
              ? "Starts after confirmation"
              : "Starts after payment completes"}
          {quote.targetTier !== "free"
            ? " · Billed " +
              (quote.interval === "year" ? "annually" : "monthly")
            : ""}
        </Text>
      </Stack>
      {quote.offerTerms && (
        <Text size="sm" fw={600}>
          {quote.offerTerms}
        </Text>
      )}
      <QuoteAmounts quote={quote} />
      {quote.nextPlanRate !== null && (
        <Text size="sm">
          {scheduled ? "Starts at " : "Renews at "}
          {formatCurrency(quote.nextPlanRate, quote.currency)}/
          {quote.interval === "year" ? "year" : "month"}
          {quote.nextAt
            ? " on " + date(quote.nextAt)
            : quote.interval === "year"
              ? ", one year after payment"
              : ", one month after payment"}
          .{" "}
          {quote.taxTreatment === "included"
            ? "Tax included."
            : "Applicable tax is calculated at billing."}
        </Text>
      )}
      {quote.endingOffer && (
        <Text size="xs" c="dimmed">
          Your {quote.endingOffer} introductory offer ends when this change
          takes effect. Switching back will not restart it.
        </Text>
      )}
      {status === "payment_required" && (
        <Alert color="gray" title="Complete payment">
          Your current plan is still active. Complete payment to apply this
          change, or cancel it.
        </Alert>
      )}
      {status === "processing" && (
        <Alert color="brand" title="Applying your change">
          We're checking your payment and plan status. Please wait before trying
          again.
        </Alert>
      )}
      {status === "quote_changed" && (
        <Alert color="yellow" title="Your total needs a fresh review">
          The previous quote has expired or changed. Review the updated total
          before approving payment. You have not been charged.
        </Alert>
      )}
      {status === "cancellation_unknown" && (
        <Alert color="yellow" title="Cancellation not confirmed">
          We couldn't confirm cancellation. Check the change status before
          retrying payment.
        </Alert>
      )}
      <ReviewActions {...props} status={status} />
    </Stack>
  );
}
