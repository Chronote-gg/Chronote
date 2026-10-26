import { useEffect, useState } from "react";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import Surface from "./Surface";
import { formatCurrency } from "../utils/pricing";
import type { useBillingRenewalRecovery } from "../hooks/useBillingRenewalRecovery";
import type { RenewalRecoveryView } from "../../types/renewalRecovery";

type Details = Exclude<RenewalRecoveryView, { status: "none" }>;
const planName = (tier: string | null) =>
  tier === "pro" ? "Pro" : tier === "basic" ? "Basic" : "Free";
function AccessDeadline({
  view,
  expired,
  grantTier,
}: {
  view: Details;
  expired: boolean;
  grantTier: "basic" | "pro" | null;
}) {
  if (expired)
    return (
      <Text size="sm">
        {grantTier
          ? `Your complimentary ${planName(grantTier)} access will continue.`
          : "Your server is now on Free."}
      </Text>
    );
  if (!view.endsAt) return null;
  const date = new Date(view.endsAt).toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (
    <Stack gap={4}>
      <Text size="sm">
        You can keep using {planName(view.priorTier)} until{" "}
        <time dateTime={view.endsAt}>{date}</time>.
      </Text>
      <Text size="sm" c="dimmed">
        {grantTier
          ? `Your complimentary ${planName(grantTier)} access will continue after that.`
          : view.status === "canceled"
            ? "Your server will move to Free then."
            : "Without payment, your server will move to Free."}
      </Text>
    </Stack>
  );
}
export default function BillingRenewalGrace({
  recovery,
  serverName,
  onUpdatePaymentMethod,
  grantTier = null,
}: {
  recovery: ReturnType<typeof useBillingRenewalRecovery>;
  serverName: string;
  onUpdatePaymentMethod: () => void;
  grantTier?: "basic" | "pro" | null;
}) {
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(Date.now);
  const view = recovery.view;
  const endsAt = view.status === "none" ? null : view.endsAt;
  useEffect(() => {
    setNow(Date.now());
    if (!endsAt) return;
    const delay = Date.parse(endsAt) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [endsAt]);
  useEffect(() => {
    setConfirming(false);
  }, [serverName, view.status]);
  if (view.status === "none") return null;
  const expired = Boolean(view.endsAt && now >= Date.parse(view.endsAt));
  const payable = view.status === "grace" && !expired;
  const title =
    view.status === "canceled"
      ? "Renewal canceled"
      : payable
        ? "Renewal payment needed"
        : "Updating your billing";
  const cancel = async () => {
    setConfirming(false);
    await recovery.cancel();
  };
  return (
    <>
      <Surface p="lg" data-testid="billing-renewal-grace">
        <Stack gap="sm" role="status" aria-live="polite">
          <Text fw={600}>{title}</Text>
          {payable ? (
            <>
              <Text size="sm">
                {view.scheduledChange
                  ? `We couldn't collect payment for your scheduled change to ${planName(view.selectedTier)}.`
                  : `We couldn't collect your ${planName(view.selectedTier)} renewal payment.`}
              </Text>
              {view.amountDue !== null && view.currency ? (
                <Text fw={600} size="sm">
                  {formatCurrency(view.amountDue, view.currency)} due
                </Text>
              ) : null}
            </>
          ) : view.status === "canceled" ? (
            <Text size="sm">You can choose another plan now.</Text>
          ) : (
            <Text size="sm">
              {view.status === "settlement_pending"
                ? "Your payment is still being settled. Please check back shortly."
                : "We're updating your billing. You can choose a new plan once this finishes."}
            </Text>
          )}
          <AccessDeadline view={view} expired={expired} grantTier={grantTier} />
          {recovery.error ? <Text size="sm">{recovery.error}</Text> : null}
          <Group gap="sm">
            {payable && view.canManage ? (
              <>
                {view.paymentUrl ? (
                  <Button
                    component="a"
                    href={view.paymentUrl}
                    disabled={recovery.busy}
                    onClick={(event) => {
                      if (recovery.busy) event.preventDefault();
                    }}
                  >
                    Retry payment
                  </Button>
                ) : null}
                <Button
                  variant="light"
                  disabled={recovery.busy}
                  onClick={onUpdatePaymentMethod}
                >
                  Update payment method
                </Button>
                <Button
                  variant="subtle"
                  disabled={recovery.busy}
                  onClick={() => setConfirming(true)}
                >
                  Cancel renewal
                </Button>
              </>
            ) : null}
            <Button
              variant="subtle"
              loading={recovery.busy}
              onClick={() => {
                void recovery.refresh();
              }}
            >
              Refresh status
            </Button>
          </Group>
          {payable && !view.canManage ? (
            <Text size="xs" c="dimmed">
              Only the original payer can retry payment or cancel this renewal.
            </Text>
          ) : null}
        </Stack>
      </Surface>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Cancel this renewal?"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            The unpaid plan charge will be removed. You can choose another plan
            once billing cleanup is complete.
          </Text>
          <AccessDeadline
            view={{ ...view, status: "canceled" }}
            expired={expired}
            grantTier={grantTier}
          />
          <Text size="xs" c="dimmed">
            This applies to {serverName}. Other charges stay payable.
          </Text>
          <Group justify="flex-end">
            <Button variant="light" onClick={() => setConfirming(false)}>
              Keep renewal
            </Button>
            <Button
              loading={recovery.busy}
              onClick={() => {
                void cancel();
              }}
            >
              Cancel renewal
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
