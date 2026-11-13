/** @jest-environment node */
import { beforeEach, afterEach, it, expect, jest } from "@jest/globals";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { captureEvent } from "../../src/services/analyticsService";
import {
  renewalStripeClientFixture,
  response,
} from "../fixtures/renewalStripeClient";
import { sourceSubscription, fundedInvoice } from "../fixtures/renewalStripe";
import {
  renewalGuildId as guildId,
  renewalSubscription,
} from "../fixtures/renewal";
import {
  buildBillingLifecycleState,
  publishBillingLifecycleTransition,
  captureBillingInvoiceOutcome,
} from "../../src/services/billingLifecycleAnalytics";
import type { GuildSubscription } from "../../src/types/db";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
const captured = jest.mocked(captureEvent);
const original = {
  mock: config.mock.enabled,
  gate: config.analytics.billingLifecycleEnabled,
};
const observedAt = new Date("2026-10-14T12:00:00Z");
const row = (provider = sourceSubscription): GuildSubscription => ({
  ...renewalSubscription,
  stripeCustomerId: "cus_renewal",
  billingAnalyticsState: buildBillingLifecycleState(provider),
});
beforeEach(() => {
  config.mock.enabled = true;
  config.analytics.billingLifecycleEnabled = true;
  resetMockStore();
  captured.mockClear();
});
afterEach(() => {
  config.mock.enabled = original.mock;
  config.analytics.billingLifecycleEnabled = original.gate;
});
it("records real renewal changes, terms updates and an ended paid relationship, without inventing a first cancellation", async () => {
  const off = structuredClone(sourceSubscription);
  const on = { ...off, cancel_at: null, cancel_at_period_end: false };
  const ended = {
    ...off,
    status: "canceled" as const,
    ended_at: off.items.data[0].current_period_end,
  };
  await publishBillingLifecycleTransition({
    previous: renewalSubscription,
    current: row(off),
    provider: off,
    observedAt,
  });
  expect(captured).not.toHaveBeenCalled();
  await publishBillingLifecycleTransition({
    previous: row(on),
    current: row(off),
    provider: off,
    observedAt,
  });
  await publishBillingLifecycleTransition({
    previous: row(off),
    current: row(off),
    provider: off,
    observedAt,
  });
  await publishBillingLifecycleTransition({
    previous: row(off),
    current: row(on),
    provider: on,
    observedAt,
  });
  await publishBillingLifecycleTransition({
    previous: row(on),
    current: row(ended),
    provider: ended,
    observedAt,
  });
  expect(
    captured.mock.calls.map(([, args]) => args?.properties?.to_state),
  ).toEqual(["renewal_off", "renewal_on", "ended"]);
  expect(
    captured.mock.calls.every(([, args]) => args?.userId === undefined),
  ).toBe(true);
  const changed = {
    ...off,
    cancel_at: off.items.data[0].current_period_end + 86400,
  };
  await publishBillingLifecycleTransition({
    previous: row(off),
    current: row(changed),
    provider: changed,
    observedAt,
  });
  expect(captured.mock.lastCall?.[1]?.properties?.change).toBe("terms_updated");
});
it.each([-1, 0, 1, 31622400, 31622401])(
  "uses a bounded provider-confirmed maturity interval of %s seconds",
  async (seconds) => {
    const off = {
      ...sourceSubscription,
      cancel_at: observedAt.getTime() / 1000 + seconds,
    };
    const on = { ...off, cancel_at: null, cancel_at_period_end: false };
    await publishBillingLifecycleTransition({
      previous: row(on),
      current: row(off),
      provider: off,
      observedAt,
    });
    expect(captured.mock.lastCall?.[1]?.properties).toMatchObject(
      seconds >= 0 && seconds <= 31622400
        ? { boundary_known: true, remaining_seconds_to_scheduled_end: seconds }
        : { boundary_known: false },
    );
    expect(captured.mock.lastCall?.[1]?.timestamp).toEqual(observedAt);
  },
);
it("keeps baselines but suppresses capture for gate-off, DNT and ambiguous operations", async () => {
  const on = {
    ...sourceSubscription,
    cancel_at: null,
    cancel_at_period_end: false,
  };
  const args = {
    previous: row(on),
    current: row(),
    provider: sourceSubscription,
    observedAt,
  };
  config.analytics.billingLifecycleEnabled = false;
  await publishBillingLifecycleTransition(args);
  config.analytics.billingLifecycleEnabled = true;
  await publishBillingLifecycleTransition({ ...args, analyticsOptOut: true });
  getMockStore().renewalControls.set(`RENEWAL_CONTROL#${guildId}`, {
    guildId,
    operationId: "missing",
    revision: "rev",
  });
  await publishBillingLifecycleTransition(args);
  expect(captured).not.toHaveBeenCalled();
});
it("matches recovery to the same failed invoice, deduplicates retries and accepts a credit-covered normal renewal", async () => {
  const f = renewalStripeClientFixture();
  const provider = {
    ...sourceSubscription,
    cancel_at: null,
    cancel_at_period_end: false,
  };
  f.provider = provider;
  getMockStore().subscriptions.set(guildId, row(provider));
  const failed = {
    ...fundedInvoice,
    status: "open" as const,
    paid: false,
    attempted: true,
    attempt_count: 1,
    amount_remaining: 1000,
  };
  f.invoice.mockResolvedValue(response(failed));
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: failed,
    outcome: "failed",
  });
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: failed,
    outcome: "failed",
  });
  const paid = {
    ...fundedInvoice,
    billing_reason: "subscription_cycle" as const,
    amount_paid: 0,
    amount_remaining: 0,
  };
  f.invoice.mockResolvedValue(response(paid));
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: paid,
    outcome: "settled",
  });
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: paid,
    outcome: "settled",
  });
  expect(captured.mock.calls.map(([name]) => name)).toEqual([
    "billing_payment_failed",
    "billing_payment_recovered",
    "billing_renewal_settled",
  ]);
  const unrelated = { ...paid, id: "in_other" };
  f.invoice.mockResolvedValue(response(unrelated));
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: unrelated,
    outcome: "settled",
  });
  expect(
    captured.mock.calls.filter(
      ([name]) => name === "billing_payment_recovered",
    ),
  ).toHaveLength(1);
  expect(JSON.stringify(captured.mock.calls)).not.toMatch(
    /sub_renewal|in_renewal|cus_renewal|price_renewal|operation_id|amount_paid/,
  );
});
it("does not count stale failed deliveries, old replaced subscriptions, mismatched customers or capture failures against billing", async () => {
  const f = renewalStripeClientFixture();
  getMockStore().subscriptions.set(guildId, {
    ...row(),
    stripeSubscriptionId: "sub_new",
  });
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: fundedInvoice,
    outcome: "settled",
  });
  expect(captured).not.toHaveBeenCalled();
  getMockStore().subscriptions.set(guildId, row());
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: fundedInvoice,
    outcome: "failed",
  });
  expect(captured).not.toHaveBeenCalled();
  f.invoice.mockResolvedValue(
    response({ ...fundedInvoice, customer: "cus_other" }),
  );
  await captureBillingInvoiceOutcome({
    stripe: f.stripe,
    invoice: fundedInvoice,
    outcome: "settled",
  });
  expect(captured).not.toHaveBeenCalled();
  captured.mockImplementationOnce(() => {
    throw Error("capture outage");
  });
  f.invoice.mockResolvedValue(
    response({ ...fundedInvoice, billing_reason: "subscription_cycle" }),
  );
  await expect(
    captureBillingInvoiceOutcome({
      stripe: f.stripe,
      invoice: fundedInvoice,
      outcome: "settled",
    }),
  ).resolves.toBeUndefined();
});
it("publishes only the reconciliation winner and never lets an old terminal subscription become a new server loss", async () => {
  const { reconcileSubscription } =
    await import("../../src/services/subscriptionReconciliation");
  const f = renewalStripeClientFixture();
  const on = {
    ...sourceSubscription,
    cancel_at: null,
    cancel_at_period_end: false,
  };
  getMockStore().subscriptions.set(guildId, row(on));
  await Promise.all([
    reconcileSubscription(f.stripe, guildId, sourceSubscription.id),
    reconcileSubscription(f.stripe, guildId, sourceSubscription.id),
  ]);
  expect(
    captured.mock.calls.filter(
      ([name]) => name === "billing_subscription_state_changed",
    ),
  ).toHaveLength(1);
  captured.mockClear();
  getMockStore().subscriptions.set(guildId, {
    ...row(on),
    stripeSubscriptionId: "sub_new",
  });
  f.provider = { ...sourceSubscription, status: "canceled" };
  await reconcileSubscription(f.stripe, guildId, sourceSubscription.id);
  expect(captured).not.toHaveBeenCalled();
  expect(getMockStore().subscriptions.get(guildId)?.stripeSubscriptionId).toBe(
    "sub_new",
  );
});
it("establishes no paid baseline for an incomplete or trial subscription", async () => {
  const { reconcileSubscription } =
    await import("../../src/services/subscriptionReconciliation");
  const f = renewalStripeClientFixture();
  f.provider = { ...sourceSubscription, status: "incomplete" };
  await reconcileSubscription(f.stripe, guildId, sourceSubscription.id);
  expect(
    getMockStore().subscriptions.get(guildId)?.billingAnalyticsState,
  ).toBeUndefined();
  f.provider = { ...sourceSubscription, status: "incomplete_expired" };
  await reconcileSubscription(f.stripe, guildId, sourceSubscription.id);
  expect(captured).not.toHaveBeenCalled();
});
it("classifies paid plan contraction without inventing another acquisition or loss", async () => {
  const before = row();
  if (!before.billingAnalyticsState) throw Error("fixture baseline");
  before.billingAnalyticsState.tier = "pro";
  await publishBillingLifecycleTransition({
    previous: before,
    current: row(),
    provider: sourceSubscription,
    observedAt,
  });
  expect(captured.mock.lastCall?.[0]).toBe(
    "billing_subscription_state_changed",
  );
  expect(captured.mock.lastCall?.[1]?.properties).toMatchObject({
    change: "plan_changed",
    previous_tier: "pro",
    tier: "basic",
    to_state: "renewal_off",
  });
});
