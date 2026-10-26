import { Divider, Group, Stack, Text } from "@mantine/core";
import type { BillingChangeReviewQuote } from "./BillingChangeReview";
import { formatCurrency } from "../utils/pricing";
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
function AmountRow({
  label,
  amount,
  currency,
}: {
  label: string;
  amount: number;
  currency: string;
}) {
  return (
    <Group justify="space-between" wrap="nowrap">
      <Text size="sm">{label}</Text>
      <Text size="sm" fw={600}>
        {formatCurrency(amount, currency)}
      </Text>
    </Group>
  );
}
export default function QuoteAmounts({
  quote,
}: {
  quote: BillingChangeReviewQuote;
}) {
  const { currency } = quote;
  if (quote.timing === "renewal")
    return (
      <Text size="sm">
        No charge today. Your current plan stays active until{" "}
        {date(quote.effectiveAt)}.
      </Text>
    );
  return (
    <Stack gap="xs">
      <AmountRow
        label={quote.chargeLabel}
        amount={quote.planCharge}
        currency={currency}
      />
      {quote.chargePeriod && (
        <Text size="xs" c="dimmed">
          {quote.chargePeriod}
        </Text>
      )}
      {quote.offerSavings > 0 && (
        <AmountRow
          label="Introductory discount"
          amount={-quote.offerSavings}
          currency={currency}
        />
      )}
      {quote.unusedCredit > 0 && (
        <AmountRow
          label={quote.creditLabel}
          amount={-quote.unusedCredit}
          currency={currency}
        />
      )}
      <AmountRow
        label={quote.taxTreatment === "included" ? "Tax included" : "Tax added"}
        amount={quote.taxAmount}
        currency={currency}
      />
      {quote.billingBalance !== 0 && (
        <AmountRow
          label={
            quote.billingBalance > 0
              ? "Previous balance"
              : "Billing credit applied"
          }
          amount={quote.billingBalance}
          currency={currency}
        />
      )}
      {quote.billingBalance > 0 && (
        <Text size="xs" c="dimmed">
          This balance is from your billing account, which may include other
          servers.
        </Text>
      )}
      <Divider />
      <Group justify="space-between">
        <Text fw={700}>Due today</Text>
        <Text fw={700} size="lg">
          {formatCurrency(quote.amountDue, currency)}
        </Text>
      </Group>
      {(quote.balanceCarriedForward ?? 0) > 0 && (
        <Text size="xs" c="dimmed">
          {formatCurrency(quote.balanceCarriedForward ?? 0, currency)} will be
          added to your next invoice.
        </Text>
      )}
      {quote.remainingCredit > 0 && (
        <Text size="xs" c="dimmed">
          {formatCurrency(quote.remainingCredit, currency)} remains as billing
          credit. It can pay future invoices for this billing account, including
          your other servers.
        </Text>
      )}
    </Stack>
  );
}
