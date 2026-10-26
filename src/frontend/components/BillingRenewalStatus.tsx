import { Button, Group, Stack, Text } from "@mantine/core";
import type { RenewalState } from "../../types/renewal";
import { renewalDate as date, renewalRate as rate } from "../utils/renewal";
import BillingRenewalOff from "./BillingRenewalOff";
import { DiscountTerms } from "./BillingRenewalTerms";
export type BillingRenewalProps = {
  state: RenewalState;
  canManageBilling: boolean;
  busy: boolean;
  onConfirm: (quoteToken: string) => void;
  onCheckStatus: (operationId: string) => void;
  onRetry: () => void;
  onPortal: () => void;
};
export default function BillingRenewalStatus(props: BillingRenewalProps) {
  const { state, canManageBilling, busy, onCheckStatus, onRetry, onPortal } =
    props;
  switch (state.kind) {
    case "off":
      return <BillingRenewalOff {...props} state={state} />;
    case "on":
      return (
        <Stack gap="xs" data-testid="renewal-on">
          <Text>
            Renews {date(state.terms.renewsAt)} at {rate(state.terms)}.
          </Text>
          <DiscountTerms terms={state.terms} />
          {canManageBilling ? (
            <Button
              variant="light"
              w="fit-content"
              disabled={busy}
              onClick={onPortal}
            >
              Manage billing
            </Button>
          ) : null}
        </Stack>
      );
    case "payment_problem":
      return (
        <Stack gap="sm" data-testid="billing-payment-attention">
          <Text fw={600}>Payment needs attention</Text>
          <Text size="sm">
            {canManageBilling
              ? "Review your payment in Stripe."
              : "The original payer can review this subscription's payment in Stripe."}
          </Text>
          {canManageBilling ? (
            <Button
              variant="light"
              w="fit-content"
              disabled={busy}
              onClick={onPortal}
            >
              Manage billing
            </Button>
          ) : null}
        </Stack>
      );
    case "processing":
      return (
        <Stack gap="sm" role="status">
          <Text fw={600}>Checking renewal</Text>
          <Text size="sm" c="dimmed">
            Last confirmed end date: {date(state.endsAt)}. We're checking
            whether renewal is back on.
          </Text>

          <Button
            variant="light"
            w="fit-content"
            loading={busy}
            disabled={busy}
            onClick={() => onCheckStatus(state.operationId)}
          >
            Check status
          </Button>
        </Stack>
      );
    case "needs_review":
      return (
        <Stack gap="sm">
          <Text fw={600}>Renewal needs review</Text>
          {state.knownEndsAt ? (
            <Text size="sm">
              Your plan currently ends {date(state.knownEndsAt)}.
            </Text>
          ) : null}
          <Text size="sm" c="dimmed">
            We couldn't confirm the approved renewal terms. Review the
            subscription in Stripe or contact support.
          </Text>
          <Group gap="sm">
            <Button
              variant="light"
              disabled={busy}
              onClick={() => onCheckStatus(state.operationId)}
            >
              Check status
            </Button>
            {canManageBilling ? (
              <Button variant="subtle" disabled={busy} onClick={onPortal}>
                Manage billing
              </Button>
            ) : null}
          </Group>
        </Stack>
      );
    case "unavailable":
      return (
        <Stack gap="sm">
          <Text size="sm">Renewal details aren't available right now.</Text>
          {state.knownEndsAt ? (
            <Text size="sm">
              Your plan currently ends {date(state.knownEndsAt)}.
            </Text>
          ) : null}
          <Group gap="sm">
            <Button variant="light" disabled={busy} onClick={onRetry}>
              Try again
            </Button>
            {canManageBilling ? (
              <Button variant="subtle" disabled={busy} onClick={onPortal}>
                Manage billing
              </Button>
            ) : null}
          </Group>
        </Stack>
      );
    case "terminal":
    case "not_applicable":
      return null;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
