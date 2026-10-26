import { useEffect, useRef } from "react";
import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import BillingChangeReview from "./BillingChangeReview";
import Surface from "./Surface";
import type { useBillingChange } from "../hooks/useBillingChange";
function reviewStatus(
  view: Extract<
    ReturnType<typeof useBillingChange>["view"],
    { kind: "operation" }
  >,
  busy: boolean,
) {
  return view.state === "review" && !busy
    ? "review"
    : view.state === "accepted" && view.paymentUrl
      ? "payment_required"
      : view.state === "canceling"
        ? "cancellation_unknown"
        : "processing";
}
export default function BillingChangePanel({
  change,
  serverName,
}: {
  change: ReturnType<typeof useBillingChange>;
  serverName: string;
}) {
  const view = change.view;
  const panel = useRef<HTMLDivElement>(null);
  const operationId = view?.kind === "operation" ? view.operationId : null;
  useEffect(() => {
    if (!operationId) return;
    panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
    panel.current?.focus({ preventScroll: true });
  }, [operationId]);
  if (change.error)
    return (
      <Alert color="gray" title="Plan change status unavailable">
        <Stack gap="xs">
          <Text size="sm">Refresh billing before starting another change.</Text>
          <Button variant="light" onClick={change.refresh}>
            Check status
          </Button>
        </Stack>
      </Alert>
    );
  if (
    view?.kind !== "operation" ||
    view.state === "succeeded" ||
    view.state === "canceled"
  )
    return null;
  if (view.state === "scheduled")
    return (
      <div
        ref={panel}
        style={{
          scrollMarginTop: "calc(var(--app-shell-header-height, 0px) + 16px)",
        }}
        tabIndex={-1}
        role="region"
        aria-label="Scheduled plan change"
      >
        <Surface p="lg">
          <Stack gap="sm">
            <Text fw={600}>Plan change scheduled</Text>
            <Text>
              Your{" "}
              {view.quote.targetTier === "free"
                ? "Free"
                : view.quote.targetTier === "basic"
                  ? "Basic"
                  : "Pro"}{" "}
              plan starts{" "}
              {new Date(view.quote.effectiveAt).toLocaleDateString()}. Your
              current plan stays active until then.
            </Text>
            <Text size="sm" c="dimmed">
              To choose a different plan, cancel this scheduled change first.
            </Text>
            <Group>
              <Button
                variant="light"
                loading={change.busy}
                onClick={change.abandon}
              >
                Cancel scheduled change
              </Button>
              <Button variant="subtle" onClick={change.refresh}>
                Refresh status
              </Button>
            </Group>
          </Stack>
        </Surface>
      </div>
    );
  const status = reviewStatus(view, change.busy);
  return (
    <div
      ref={panel}
      style={{
        scrollMarginTop: "calc(var(--app-shell-header-height, 0px) + 16px)",
      }}
      tabIndex={-1}
      role="region"
      aria-label="Plan change review"
    >
      <Surface p="lg">
        <BillingChangeReview
          quote={{ ...view.quote, serverName }}
          status={status}
          onConfirm={change.approve}
          onBack={change.abandon}
          onContinuePayment={change.pay}
          onChangeSelection={change.abandon}
          onRefreshQuote={change.refresh}
          onCheckStatus={change.refresh}
        />
      </Surface>
    </div>
  );
}
