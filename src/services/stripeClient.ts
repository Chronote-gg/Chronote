import Stripe from "stripe";
import { config } from "./configService";
import type { StripeClient } from "../types/stripe";

let stripeClient: StripeClient | null | undefined;

export function getStripeClient(): StripeClient | null {
  if (stripeClient !== undefined) {
    return stripeClient;
  }
  stripeClient = config.stripe.secretKey
    ? new Stripe(config.stripe.secretKey, { apiVersion: "2026-04-22.dahlia" })
    : null;
  return stripeClient;
}
