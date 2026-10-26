import { Accordion, Button, Stack, Text } from "@mantine/core";
import type { FirstYearPayment } from "../../types/pricing";
import { formatCurrency } from "../utils/pricing";
const date = (value: string) =>
  new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
type Props = {
  firstYearPayment: FirstYearPayment | null | undefined;
  previousStatus: string;
  canViewReceipts: boolean;
  onViewReceipts: () => void;
  busy: boolean;
};
export default function BillingPaymentHistory({
  firstYearPayment,
  previousStatus,
  canViewReceipts,
  onViewReceipts,
  busy,
}: Props) {
  const previous =
    previousStatus === "canceled" || previousStatus === "incomplete_expired";
  if (!firstYearPayment && !canViewReceipts && !previous) return null;
  return (
    <Stack gap="sm" data-testid="billing-payment-history">
      <Accordion variant="separated">
        <Accordion.Item value="payment-history">
          <Accordion.Control>Payment history</Accordion.Control>
          <Accordion.Panel>
            <Stack gap="xs">
              {previous ? (
                <Text size="sm">
                  Previous subscription:{" "}
                  {previousStatus === "canceled" ? "Canceled" : "Expired"}.
                </Text>
              ) : null}
              {firstYearPayment?.status === "available" ? (
                <>
                  <Text size="sm" fw={600} c="var(--mantine-color-text)">
                    {formatCurrency(
                      firstYearPayment.amountPaid,
                      firstYearPayment.currency,
                    )}{" "}
                    paid
                  </Text>
                  <Text size="sm" c="var(--mantine-color-text)">
                    {date(firstYearPayment.periodStartsAt)} to{" "}
                    {date(firstYearPayment.periodEndsAt)}
                  </Text>
                </>
              ) : (
                <Text size="sm" c="var(--mantine-color-text)">
                  {canViewReceipts
                    ? "Open your invoices and receipts for payment details."
                    : "Payment details aren't available here. The original payer can view invoices and receipts."}
                </Text>
              )}
              {previousStatus === "canceled" ||
              previousStatus === "incomplete_expired" ? (
                <Text size="sm" c="var(--mantine-color-text)">
                  These payments are from the previous subscription.
                </Text>
              ) : null}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
      {canViewReceipts ? (
        <Button
          variant="subtle"
          w="fit-content"
          loading={busy}
          disabled={busy}
          onClick={onViewReceipts}
        >
          View invoices and receipts
        </Button>
      ) : null}
    </Stack>
  );
}
