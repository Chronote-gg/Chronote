import { jest } from "@jest/globals";
import Stripe from "stripe";
import {
  sourceSubscription,
  fundedInvoice,
  renewalPreview,
} from "./renewalStripe";
import { renewalPayerId as payerId } from "./renewal";
import type { StripeSubscription } from "../../src/types/stripe";
export const response = <T extends object>(value: T): Stripe.Response<T> =>
  Object.assign(value, {
    lastResponse: { headers: {}, requestId: "req_fixture", statusCode: 200 },
  });
export function renewalStripeClientFixture() {
  let provider: StripeSubscription = structuredClone(sourceSubscription);
  const stripe = new Stripe("sk_test_fixture");
  const retrieve = jest
    .spyOn(stripe.subscriptions, "retrieve")
    .mockImplementation(async () => response(provider));
  const invoice = jest
    .spyOn(stripe.invoices, "retrieve")
    .mockResolvedValue(response(fundedInvoice));
  const preview = jest
    .spyOn(stripe.invoices, "createPreview")
    .mockResolvedValue(response(renewalPreview));
  const customer = jest
    .spyOn(stripe.customers, "retrieve")
    .mockResolvedValue(
      response({ id: "cus_renewal", object: "customer", deleted: true }),
    );
  customer.mockImplementation(async () =>
    response({
      id: "cus_renewal",
      object: "customer",
      address: null,
      balance: 0,
      created: sourceSubscription.created,
      currency: "usd",
      default_source: null,
      delinquent: false,
      description: null,
      email: null,
      invoice_prefix: "FIXTURE",
      invoice_settings: {
        custom_fields: null,
        default_payment_method: "pm_fixture",
        footer: null,
        rendering_options: null,
      },
      livemode: false,
      metadata: { discord_id: payerId },
      name: null,
      phone: null,
      shipping: null,
      tax_exempt: "none",
    }),
  );
  const update = jest
    .spyOn(stripe.subscriptions, "update")
    .mockImplementation(async () => {
      provider = {
        ...provider,
        cancel_at: null,
        cancel_at_period_end: false,
        canceled_at: null,
      };
      return response(provider);
    });
  const checkout = jest.spyOn(stripe.checkout.sessions, "create");
  const resume = jest.spyOn(stripe.subscriptions, "resume");
  return {
    stripe,
    retrieve,
    invoice,
    preview,
    customer,
    update,
    checkout,
    resume,
    get provider() {
      return provider;
    },
    set provider(value: StripeSubscription) {
      provider = value;
    },
  };
}
