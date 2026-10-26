import { Text } from "@mantine/core";
import type { RenewalTerms } from "../../types/renewal";
import { formatCurrency } from "../utils/pricing";
import { renewalDate as date } from "../utils/renewal";
export const DiscountTerms = ({ terms }: { terms: RenewalTerms }) => {
  if (!terms.discount) return null;
  return (
    <Text size="sm" c="dimmed">
      Your discount ends {date(terms.discount.endsAt)}. Then{" "}
      {formatCurrency(terms.discount.regularUnitAmount, terms.currency)}/
      {terms.interval === "year" ? "year" : "month"}
      {terms.taxBehavior === "inclusive" ? ", tax included." : " before tax."}
    </Text>
  );
};
