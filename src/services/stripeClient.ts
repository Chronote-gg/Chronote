import Stripe from "stripe";
import { config } from "./configService";

let stripeClient: Stripe | null | undefined;

export function getStripeClient(): Stripe | null {
  if (stripeClient !== undefined) {
    return stripeClient;
  }
  stripeClient = config.stripe.secretKey
    ? new Stripe(config.stripe.secretKey, { apiVersion: "2026-01-28.clover" })
    : null;
  return stripeClient;
}
