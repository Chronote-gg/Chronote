import { beforeEach, afterEach } from "@jest/globals";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  trackPaidRenewalPeriod,
  refreshRenewalRecovery,
} from "../../src/services/renewalRecoveryService";
import { sourceSubscription, fundedInvoice, paidEndsAt } from "./renewalStripe";
import { renewalSubscription } from "./renewal";
import { stripeTransport } from "./stripeTransport";

function invoiceResponse(input: {
  invoice: import("../../src/types/stripe").StripeInvoice | undefined;
  fields: URLSearchParams;
  requireCouponExpansion: boolean;
}) {
  const { invoice, fields, requireCouponExpansion } = input;
  const expanded = [...fields].some(
    ([key, value]) =>
      key.startsWith("expand") && value === "discounts.source.coupon",
  );
  return invoice && requireCouponExpansion && !expanded
    ? {
        ...invoice,
        discounts: invoice.discounts.map((discount) =>
          typeof discount === "string" ? discount : discount.id,
        ),
      }
    : invoice;
}
export function renewalRecoveryFixture() {
  const subscription = {
    ...sourceSubscription,
    metadata: { ...sourceSubscription.metadata },
    items: {
      ...sourceSubscription.items,
      data: sourceSubscription.items.data.map((item) => ({
        ...item,
        price: {
          ...item.price,
          recurring: item.price.recurring ? { ...item.price.recurring } : null,
        },
      })),
    },
  };
  subscription.cancel_at = null;
  subscription.cancel_at_period_end = false;
  const renewal = {
    ...fundedInvoice,
    metadata: { ...fundedInvoice.metadata },
    status_transitions: { ...fundedInvoice.status_transitions },
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        period: { ...line.period },
        pricing: line.pricing
          ? {
              ...line.pricing,
              price_details: line.pricing.price_details
                ? { ...line.pricing.price_details }
                : null,
            }
          : null,
      })),
    },
  };
  renewal.id = "in_renewal";
  renewal.billing_reason = "subscription_cycle";
  renewal.status = "open";
  renewal.amount_paid = 0;
  renewal.amount_remaining = 1000;
  renewal.status_transitions.finalized_at = paidEndsAt + 3600;
  renewal.created = paidEndsAt;
  renewal.lines.data[0].id = "il_renewal";
  renewal.lines.data[0].invoice = renewal.id;
  renewal.lines.data[0].period = {
    start: paidEndsAt,
    end: paidEndsAt + 2592000,
  };
  const invoices = new Map([
    [fundedInvoice.id, { ...fundedInvoice }],
    [renewal.id, renewal],
  ]);
  let processing = false;
  let requireCouponExpansion = false;
  const transport = stripeTransport((request) => {
    if (request.path === `/v1/subscriptions/${subscription.id}`)
      return subscription;
    if (request.path === "/v1/customers/cus_renewal")
      return {
        id: "cus_renewal",
        livemode: false,
        metadata: { discord_id: subscription.metadata.discord_id },
      };
    if (request.path === "/v1/invoice_payments")
      return {
        object: "list",
        has_more: false,
        url: request.path,
        data: processing
          ? [
              {
                id: "ip_owned",
                invoice: renewal.id,
                status: "open",
                livemode: false,
                currency: "usd",
                payment: { type: "payment_intent", payment_intent: "pi_owned" },
              },
            ]
          : [],
      };
    if (request.path === "/v1/payment_intents/pi_owned")
      return {
        id: "pi_owned",
        customer: "cus_renewal",
        livemode: false,
        currency: "usd",
        status: "processing",
      };
    if (request.path.startsWith("/v1/prices/"))
      return subscription.items.data[0].price;
    if (request.path.startsWith("/v1/invoices/"))
      return invoiceResponse({
        invoice: invoices.get(request.path.split("/").at(-1) ?? ""),
        fields: request.fields,
        requireCouponExpansion,
      });
    if (request.path === "/v1/invoices")
      return {
        object: "list",
        data: [...invoices.values()].filter(
          (invoice) =>
            !request.fields.get("status") ||
            invoice.status === request.fields.get("status"),
        ),
        has_more: false,
        url: request.path,
      };
    throw new Error(`Unexpected request ${request.path}`);
  });
  const track = () =>
    trackPaidRenewalPeriod({
      stripe: transport.stripe,
      guildId: renewalSubscription.guildId,
      subscriptionId: subscription.id,
      invoiceId: fundedInvoice.id,
      now: paidEndsAt - 1,
    });
  const refresh = (now = paidEndsAt + 4000) =>
    refreshRenewalRecovery({
      stripe: transport.stripe,
      guildId: renewalSubscription.guildId,
      now,
    });
  const fail = () => {
    subscription.status = "past_due";
    subscription.latest_invoice = renewal.id;
    subscription.items.data[0].current_period_start =
      renewal.lines.data[0].period.start;
    subscription.items.data[0].current_period_end =
      renewal.lines.data[0].period.end;
  };
  return {
    ...transport,
    subscription,
    renewal,
    invoices,
    processing(value: boolean) {
      processing = value;
    },
    requireCouponExpansion() {
      requireCouponExpansion = true;
    },
    track,
    refresh,
    fail,
  };
}

export function installRenewalRecoveryTestState() {
  const original = {
    mock: config.mock.enabled,
    enabled: config.stripe.renewalGraceEnabled,
    mode: config.subscription.stripeMode,
  };
  beforeEach(() => {
    config.mock.enabled = true;
    config.subscription.stripeMode = "test";
    config.stripe.renewalGraceEnabled = true;
    resetMockStore();
    getMockStore().subscriptions.set(
      renewalSubscription.guildId,
      structuredClone(renewalSubscription),
    );
  });
  afterEach(() => {
    config.mock.enabled = original.mock;
    config.stripe.renewalGraceEnabled = original.enabled;
    config.subscription.stripeMode = original.mode;
  });
}
