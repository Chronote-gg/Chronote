import type { StripeClient } from "../types/stripe";
import { BillingActionError } from "./billingActionError";
export async function assertStripePayer({
  stripe,
  customerId,
  payerId,
}: {
  stripe: StripeClient;
  customerId: string;
  payerId: string;
}): Promise<void> {
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted || customer.metadata.discord_id !== payerId)
    throw new BillingActionError(
      "FORBIDDEN",
      "Only the original payer can manage this server's Stripe billing",
    );
}
