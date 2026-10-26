import { Badge, Group, Text } from "@mantine/core";
import type { BasicIntroOffer } from "../../types/pricing";
import { formatCurrency } from "../utils/pricing";

export default function IntroPriceComparison({
  offer,
}: {
  offer: BasicIntroOffer;
}) {
  if (offer.status !== "available") return null;
  return (
    <Group gap="xs" wrap="wrap" data-testid="basic-intro-discount">
      <Text
        component="del"
        size="sm"
        c="var(--mantine-color-text)"
        style={{
          textDecoration: "line-through",
          textDecorationThickness: "1.5px",
        }}
        aria-label="Regular price"
      >
        {formatCurrency(offer.regularUnitAmount, offer.currency)} /{" "}
        {offer.id === "basic_intro_v1" ? "mo" : "yr"}
      </Text>
      <Badge
        variant="light"
        color="brand"
        radius="sm"
        tt="none"
        style={{ color: "var(--mantine-color-text)" }}
      >
        {offer.percentOff}% off
      </Badge>
    </Group>
  );
}
