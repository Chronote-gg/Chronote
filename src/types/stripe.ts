import Stripe from "stripe";
import type { Stripe as StripeTypes } from "stripe/cjs/stripe.core";

export type StripeClient = InstanceType<typeof Stripe>;
export type StripeCheckoutSession = StripeTypes.Checkout.Session;
export type StripeEvent = StripeTypes.Event;
export type StripeInvoice = StripeTypes.Invoice;
export type StripeMetadata = StripeTypes.Metadata;
export type StripePrice = StripeTypes.Price;
export type StripeSubscription = StripeTypes.Subscription;
