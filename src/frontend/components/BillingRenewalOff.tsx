import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import type { RenewalAction, RenewalState } from "../../types/renewal";
import type { BillingRenewalProps } from "./BillingRenewalStatus";
import { DiscountTerms } from "./BillingRenewalTerms";
import {
  renewalDate as date,
  renewalTierName as tierName,
  renewalRate as rate,
} from "../utils/renewal";
const BillingRenewalOff = ({
  state,
  canManageBilling,
  busy,
  onConfirm,
  onRetry,
  onPortal,
}: Omit<BillingRenewalProps, "onCheckStatus"> & {
  state: Extract<RenewalState, { kind: "off" }>;
}) => {
  const action: RenewalAction = canManageBilling
    ? state.action
    : { kind: "payer_required" };
  return (
    <Stack gap="sm" data-testid="renewal-off">
      <Badge color="gray" variant="light" w="fit-content">
        Renewal off
      </Badge>
      <Text>
        Your {tierName(state.tier)} plan ends {date(state.endsAt)}.
      </Text>
      {action.kind === "ready" ? (
        <>
          <Text>Turn renewal back on to continue at {rate(action.terms)}.</Text>
          <DiscountTerms terms={action.terms} />
          <Group gap="sm">
            <Button
              loading={busy}
              disabled={busy}
              onClick={() => onConfirm(action.quoteToken)}
            >
              Turn renewal back on
            </Button>
            <Button variant="subtle" disabled={busy} onClick={onPortal}>
              Manage billing
            </Button>
          </Group>
        </>
      ) : action.kind === "payer_required" ? (
        <Text size="sm" c="dimmed">
          The original payer can manage this subscription's renewal.
        </Text>
      ) : (
        <>
          <Text size="sm" c="dimmed">
            {action.kind === "unavailable"
              ? "Renewal details aren't available right now."
              : action.reason === "payment_problem"
                ? "Review your payment before turning renewal back on."
                : "Review this subscription's renewal in Stripe."}
          </Text>
          <Group gap="sm">
            {action.kind === "unavailable" ? (
              <Button variant="light" disabled={busy} onClick={onRetry}>
                Try again
              </Button>
            ) : null}
            {canManageBilling ? (
              <Button variant="light" disabled={busy} onClick={onPortal}>
                {action.kind === "review_in_stripe" &&
                action.reason !== "payment_problem"
                  ? "Review renewal in Stripe"
                  : "Manage billing"}
              </Button>
            ) : null}
          </Group>
        </>
      )}
    </Stack>
  );
};

export default BillingRenewalOff;
