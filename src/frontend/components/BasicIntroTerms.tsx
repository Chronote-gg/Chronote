import { Stack, Text } from "@mantine/core";
import type { BasicIntroOffer } from "../../types/pricing";
import { introOfferTerms } from "../utils/pricing";

export default function BasicIntroTerms({ offer }: { offer: BasicIntroOffer }) {
  if (offer.status !== "available") return null;
  const deadline =
    offer.enrollmentEndsAt && !offer.reservedForCheckout
      ? new Date(offer.enrollmentEndsAt)
      : null;
  return (
    <Stack gap={4} mt="sm" data-testid="basic-intro-terms">
      <Text size="sm" fw={600} c="var(--mantine-color-text)">
        {introOfferTerms(offer)}
      </Text>
      <Text size="xs" c="var(--mantine-color-text)">
        Each offer is available once per server. Cannot combine with other
        offers. Auto-renews. Tax may apply.
      </Text>
      {deadline ? (
        <Text size="xs" c="var(--mantine-color-text)">
          Enroll by{" "}
          {deadline.toLocaleString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            fractionalSecondDigits: deadline.getMilliseconds() ? 3 : undefined,
            timeZoneName: "short",
          })}
          .
        </Text>
      ) : null}
    </Stack>
  );
}
