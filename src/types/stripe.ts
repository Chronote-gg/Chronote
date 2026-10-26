import Stripe from "stripe";
import type StripeTypes from "stripe";

export type StripeClient = InstanceType<typeof Stripe>;
export type StripeEffect = <T>(run: () => Promise<T>) => Promise<T>;
export type StripeCheckoutSession = StripeTypes.Checkout.Session;
export type StripeEvent = StripeTypes.Event;
export type StripeInvoice = StripeTypes.Invoice;
export type StripeMetadata = StripeTypes.Metadata;
export type StripePrice = StripeTypes.Price;
export type StripeSubscription = StripeTypes.Subscription;
