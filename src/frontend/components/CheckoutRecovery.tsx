import { Alert, Button, Group, Stack, Text } from "@mantine/core";
import type { BasicIntroOffer } from "../../types/pricing";

export function IntroOfferAvailability({ offer }: { offer: BasicIntroOffer }) {
  return (
    <>
      {offer.status === "unavailable" && (
        <Alert title="Introductory pricing unavailable" color="yellow">
          Basic introductory pricing could not be confirmed right now. Refresh
          offers in a moment to try again. If this keeps happening, contact
          support.
        </Alert>
      )}
      {offer.status === "expired" && (
        <Alert title="Introductory enrollment ended" color="gray">
          The regular Basic price is shown. Choose a plan to continue at that
          price.
        </Alert>
      )}
    </>
  );
}

export default function CheckoutRecovery({
  offer,
  checkoutFailed,
  retryDisabled,
  refreshDisabled,
  onRetry,
  onRefresh,
}: {
  offer: BasicIntroOffer;
  checkoutFailed: boolean;
  retryDisabled: boolean;
  refreshDisabled: boolean;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  if (offer.status !== "unavailable" && !checkoutFailed) return null;
  return (
    <Stack gap="xs">
      {checkoutFailed && (
        <Text size="sm">
          Checkout could not be opened. Retry checkout keeps the same plan and
          terms. To choose differently, refresh offers first. A new checkout
          replaces any earlier one that was not paid.
        </Text>
      )}
      <Group>
        {checkoutFailed && (
          <Button disabled={retryDisabled} onClick={onRetry}>
            Retry checkout
          </Button>
        )}
        <Button disabled={refreshDisabled} variant="light" onClick={onRefresh}>
          Refresh offers
        </Button>
      </Group>
    </Stack>
  );
}
