/** @jest-environment node */
import { resolveRenewalAccess } from "../../src/services/renewalRecoveryAccess";
import { reconcileSubscription } from "../../src/services/subscriptionReconciliation";
import { getRenewalRecoveryView } from "../../src/services/renewalRecoveryView";
import { offerUsageKey, offerUsageSchema } from "../../src/types/offerUsage";
import { renewalRecoveryKey } from "../../src/types/renewalRecovery";
import { classifyChangeHistory } from "../../src/services/billingChangeHistory";
import { cancelBillingChange } from "../../src/services/billingChangeService";
import * as renewalProvider from "../../src/services/renewalRecoveryProvider";
import * as renewalPayer from "../../src/services/billingPayerService";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getRenewalRecoveryRepository } from "../../src/repositories/renewalRecoveryRepository";
import {
  trackPaidRenewalPeriod,
  cancelRenewalRecovery,
  cancelScheduledRenewalRecovery,
  reconcileRenewalRecovery,
  completeRenewalPaidProjection,
} from "../../src/services/renewalRecoveryService";
import { changeOperation } from "../fixtures/billingChange";
import {
  fundedInvoice,
  remainingDiscount,
  paidEndsAt,
} from "../fixtures/renewalStripe";
import { renewalSubscription } from "../fixtures/renewal";
import { renewalRecoveryFixture as fixture } from "../fixtures/renewalRecoveryService";

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
test("discovers failed renewal from the saved paid boundary when webhooks are dropped", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const record = await f.refresh();
  expect(record).toMatchObject({
    state: "grace",
    endsAt: paidEndsAt + 3600 + 172800,
    enforcementAccepted: true,
    paid: { tier: "basic" },
  });
  const later = await f.refresh(paidEndsAt + 9000);
  expect(later).toMatchObject({ endsAt: paidEndsAt + 3600 + 172800 });
});

test.each(["basic", "pro"] as const)(
  "tracks %s monthly and annual paid periods",
  async (tier) => {
    for (const interval of ["month", "year"] as const) {
      resetMockStore();
      getMockStore().subscriptions.set(
        renewalSubscription.guildId,
        structuredClone(renewalSubscription),
      );
      const f = fixture();
      const price = f.subscription.items.data[0].price;
      price.lookup_key = `chronote_${tier}_${interval === "month" ? "monthly" : "annual"}`;
      if (!price.recurring) throw new Error("Missing recurring fixture");
      price.recurring.interval = interval;
      await f.track();
      expect(
        (
          await getRenewalRecoveryRepository().getCurrent(
            renewalSubscription.guildId,
          )
        )?.paid,
      ).toMatchObject({ tier, interval });
    }
  },
);
test("keeps draft, unattempted and unknown invoice states out of failed-payment grace", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  f.renewal.status = "draft";
  f.renewal.attempted = false;
  f.renewal.status_transitions.finalized_at = null;
  expect(await f.refresh()).toMatchObject({
    state: "watching",
    enforcementAccepted: false,
  });
});
test("does not adopt a new grace or block billing while the flag is off", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  config.stripe.renewalGraceEnabled = false;
  expect(await f.refresh()).toMatchObject({
    state: "grace",
    enforcementAccepted: false,
  });
  expect(
    getMockStore().renewalRecoveryPointers.get(renewalSubscription.guildId)
      ?.blocking,
  ).toBe(false);
});
test.each(["ordinary", "foreign_operation"] as const)(
  "does not use passive coverage to authorize %s cancellation",
  async (scope) => {
    const f = fixture();
    await f.track();
    f.fail();
    config.stripe.renewalGraceEnabled = false;
    await f.refresh();
    const input = {
      stripe: f.stripe,
      guildId: renewalSubscription.guildId,
      payerId: f.subscription.metadata.discord_id,
      now: paidEndsAt + 4001,
    };
    await expect(
      scope === "ordinary"
        ? cancelRenewalRecovery(input)
        : cancelScheduledRenewalRecovery({
            ...input,
            operationId: "other_operation",
          }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
    expect(
      await getRenewalRecoveryRepository().getCurrent(input.guildId),
    ).toMatchObject({ state: "grace", enforcementAccepted: false });
  },
);

test.each(["customer", "mode", "credited", "first_purchase", "funding"])(
  "rejects unsafe renewal evidence: %s",
  async (mismatch) => {
    const f = fixture();
    await f.track();
    f.fail();
    if (mismatch === "customer") f.renewal.customer = "cus_other";
    if (mismatch === "mode") f.renewal.livemode = true;
    if (mismatch === "credited") f.renewal.pre_payment_credit_notes_amount = 10;
    if (mismatch === "first_purchase")
      f.renewal.billing_reason = "subscription_create";
    if (mismatch === "funding")
      f.renewal.metadata.chronote_invoice_role = "funding";
    await expect(f.refresh()).rejects.toThrow();
    expect(
      (
        await getRenewalRecoveryRepository().getCurrent(
          renewalSubscription.guildId,
        )
      )?.state,
    ).toBe("watching");
  },
);
test.each(["void", "uncollectible"] as const)(
  "keeps an unattempted terminal %s renewal cancelable during its original grace",
  async (status) => {
    const f = fixture();
    await f.track();
    f.fail();
    f.renewal.status = status;
    f.renewal.attempted = false;
    f.renewal.hosted_invoice_url = null;
    if (status === "void") f.renewal.amount_remaining = 0;
    const grace = await f.refresh();
    expect(grace).toMatchObject({
      state: "grace",
      enforcementAccepted: true,
      endsAt: paidEndsAt + 3600 + 172800,
    });
    expect(
      await getRenewalRecoveryView({
        stripe: f.stripe,
        guildId: renewalSubscription.guildId,
        payerId: f.subscription.metadata.discord_id,
        now: paidEndsAt + 4001,
      }),
    ).toMatchObject({
      status: "grace",
      canManage: true,
      paymentUrl: null,
      amountDue: status === "void" ? null : 1000,
    });
  },
);

test("accepts a paid period funded by customer credit without requiring paid cash", async () => {
  const f = fixture();
  const invoice = f.invoices.get(fundedInvoice.id);
  if (!invoice) throw new Error("Missing invoice");
  invoice.amount_paid = 0;
  invoice.amount_due = 0;
  invoice.starting_balance = -1000;
  await f.track();
  expect(
    (
      await getRenewalRecoveryRepository().getCurrent(
        renewalSubscription.guildId,
      )
    )?.paid.invoiceId,
  ).toBe(fundedInvoice.id);
});
test("refuses to reuse reversed paid service and ignores an old subscription after replacement", async () => {
  const f = fixture();
  const invoice = f.invoices.get(fundedInvoice.id);
  if (!invoice) throw new Error("Missing invoice");
  invoice.post_payment_credit_notes_amount = 1000;
  await expect(f.track()).rejects.toThrow();
  invoice.post_payment_credit_notes_amount = 0;
  await f.track();
  f.fail();
  getMockStore().subscriptions.set(renewalSubscription.guildId, {
    ...renewalSubscription,
    stripeSubscriptionId: "sub_new",
    stripeSyncRevision: "new",
  });
  expect((await f.refresh())?.state).toBe("watching");
  expect(
    f.requests.filter((request) => request.path === "/v1/invoices"),
  ).toHaveLength(0);
});

test("recognizes a scheduled downgrade but treats its old metadata as ordinary next cycle", async () => {
  const { f, operation } = await scheduledFixture();
  expect(await f.refresh()).toMatchObject({
    state: "grace",
    scheduledOperationId: operation.operationId,
    paid: { tier: "pro" },
  });
  f.renewal.status = "paid";
  f.renewal.amount_remaining = 0;
  expect(await f.refresh()).toMatchObject({
    state: "paid",
    projection: { state: "pending" },
  });
  const beforeProjection = getMockStore().renewalRecoveryPointers.get(
    renewalSubscription.guildId,
  );
  expect(beforeProjection?.blocking).toBe(true);
  expect(
    (
      await getRenewalRecoveryRepository().listDue({
        mode: "test",
        now: paidEndsAt + 4000,
        limit: 100,
      })
    ).keys,
  ).toContain(beforeProjection?.key);
  const saved = {
    ...renewalSubscription,
    status: "active",
    tier: "basic",
    priceId: "price_basic",
  };
  getMockStore().subscriptions.set(saved.guildId, saved);
  f.subscription.status = "active";
  await completeRenewalPaidProjection(saved.guildId, f.subscription, saved);
  expect(
    getMockStore().renewalRecoveryPointers.get(saved.guildId)?.blocking,
  ).toBe(false);
  expect(
    (
      await getRenewalRecoveryRepository().listDue({
        mode: "test",
        now: paidEndsAt + 4000,
        limit: 100,
      })
    ).keys,
  ).not.toContain(beforeProjection?.key);
  await trackPaidRenewalPeriod({
    stripe: f.stripe,
    guildId: renewalSubscription.guildId,
    subscriptionId: f.subscription.id,
    invoiceId: f.renewal.id,
    now: paidEndsAt + 4000,
  });
  const next = {
    ...f.renewal,
    id: "in_following",
    status: "open" as const,
    amount_remaining: 1000,
    created: f.renewal.lines.data[0].period.end,
    status_transitions: {
      ...f.renewal.status_transitions,
      finalized_at: f.renewal.lines.data[0].period.end,
    },
    lines: {
      ...f.renewal.lines,
      data: f.renewal.lines.data.map((line) => ({
        ...line,
        id: "il_following",
        period: { start: line.period.end, end: line.period.end + 2592000 },
      })),
    },
  };
  f.invoices.set(next.id, next);
  f.subscription.latest_invoice = next.id;
  f.subscription.items.data[0].current_period_start =
    next.lines.data[0].period.start;
  f.subscription.items.data[0].current_period_end =
    next.lines.data[0].period.end;
  expect(await f.refresh(next.created + 100)).toMatchObject({
    state: "grace",
    scheduledOperationId: null,
  });
});

test("accepts the provider's expanded price reference on a renewal service line", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const pricing = f.renewal.lines.data[0].pricing;
  if (!pricing?.price_details) throw new Error("Missing price fixture");
  pricing.price_details = {
    ...pricing.price_details,
    price: f.subscription.items.data[0].price,
  };
  expect(await f.refresh()).toMatchObject({ state: "grace" });
});

test("explicit cancellation keeps its grace deadline and releases billing only after saved Free access", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace || grace.state !== "grace") throw new Error("Expected grace");
  const payer = jest
    .spyOn(renewalPayer, "assertStripePayer")
    .mockResolvedValue();
  const provider = jest
    .spyOn(renewalProvider, "cancelUnpaidRenewal")
    .mockImplementation(async (input) => {
      if (input.recovery.state !== "canceling")
        throw new Error("Expected cancellation");
      await input.onReceipt({
        ...input.recovery,
        revision: "native-canceled",
        receipts: {
          ...input.recovery.receipts,
          canceled: true,
          collectionRestored: true,
          collectionToRestore: [],
        },
      });
      f.subscription.status = "canceled";
      return "canceled";
    });
  try {
    await cancelRenewalRecovery({
      stripe: f.stripe,
      guildId: grace.guildId,
      payerId: grace.payerId,
      now: paidEndsAt + 4001,
    });
    expect(
      await getRenewalRecoveryRepository().getCurrent(grace.guildId),
    ).toMatchObject({ state: "canceled", endsAt: grace.endsAt });
    expect(
      getMockStore().renewalRecoveryPointers.get(grace.guildId)?.blocking,
    ).toBe(false);
    expect(getMockStore().subscriptions.get(grace.guildId)).toMatchObject({
      status: "canceled",
      tier: "free",
    });
  } finally {
    provider.mockRestore();
    payer.mockRestore();
  }
});
test("expiry starts cleanup automatically and retains control when the provider is unavailable", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace || grace.state !== "grace") throw new Error("Expected grace");
  const provider = jest
    .spyOn(renewalProvider, "cancelUnpaidRenewal")
    .mockRejectedValue(new Error("Provider unavailable"));
  try {
    await expect(
      reconcileRenewalRecovery({
        stripe: f.stripe,
        guildId: grace.guildId,
        now: grace.endsAt,
      }),
    ).rejects.toThrow("Provider unavailable");
    expect(
      await getRenewalRecoveryRepository().getCurrent(grace.guildId),
    ).toMatchObject({
      state: "canceling",
      reason: "expired",
      endsAt: grace.endsAt,
    });
    expect(
      getMockStore().renewalRecoveryPointers.get(grace.guildId)?.blocking,
    ).toBe(true);
  } finally {
    provider.mockRestore();
  }
});
test("rejects another payer before any cancellation write", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace) throw new Error("Expected grace");
  await expect(
    cancelRenewalRecovery({
      stripe: f.stripe,
      guildId: grace.guildId,
      payerId: "another-payer",
      now: paidEndsAt + 4001,
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    (await getRenewalRecoveryRepository().getCurrent(grace.guildId))?.state,
  ).toBe("grace");
});
test("a paid renewal completes access reconciliation and queues its next paid period", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace) throw new Error("Expected grace");
  f.renewal.status = "paid";
  f.renewal.amount_remaining = 0;
  f.subscription.status = "active";
  await reconcileRenewalRecovery({
    stripe: f.stripe,
    guildId: grace.guildId,
    now: paidEndsAt + 5000,
  });
  expect(
    await getRenewalRecoveryRepository().getCurrent(grace.guildId),
  ).toMatchObject({ state: "watching", paid: { invoiceId: f.renewal.id } });
  expect(
    getMockStore().renewalRecoveryPointers.get(grace.guildId)?.blocking,
  ).toBe(false);
});

async function scheduledFixture(withOffer = false) {
  const f = fixture();
  f.subscription.items.data[0].price.lookup_key = "chronote_pro_monthly";
  await f.track();
  f.fail();
  f.subscription.items.data[0].price.id = "price_basic";
  f.subscription.items.data[0].price.lookup_key = "chronote_basic_monthly";
  const pricing = f.renewal.lines.data[0].pricing;
  if (!pricing?.price_details) throw new Error("Missing price fixture");
  pricing.price_details = { ...pricing.price_details, price: "price_basic" };
  const operation = {
    ...changeOperation,
    payerId: f.subscription.metadata.discord_id,
    timing: "renewal" as const,
    state: "scheduled" as const,
    scheduleId: "sub_sched",
    consent: { at: paidEndsAt - 100, quoteRevision: changeOperation.revision },
    source: {
      ...changeOperation.source,
      customerId: "cus_renewal",
      periodEnd: paidEndsAt,
    },
    target: {
      ...changeOperation.target,
      priceId: "price_basic",
      unitAmount: 1000,
      selection: {
        tier: "basic" as const,
        interval: "month" as const,
        expectedOffer: "none" as const,
      },
    },
  };
  if (withOffer) {
    operation.target.offer = {
      id: "basic_intro_v1",
      authority: {
        guildId: operation.guildId,
        mode: "test",
        offerId: "basic_intro_v1",
        accountId: "acct_owned",
        coverageRevision: "coverage",
        boundaryRevision: "boundary",
        writerImageDigest: "sha256:" + "a".repeat(64),
      },
      terms: {
        interval: "month",
        currency: "usd",
        priceId: "price_basic",
        couponId: "co_monthly",
        regularUnitAmount: 1000,
        discountedUnitAmount: 600,
        durationMonths: 3,
      },
    };
    getMockStore().offerUsages.set(
      offerUsageKey(operation.guildId, "basic_intro_v1", "test"),
      offerUsageSchema.parse({
        guildId: operation.guildId,
        mode: "test",
        offerId: "basic_intro_v1",
        revision: "reserved",
        state: "reserved",
        operationId: operation.operationId,
        reservedAt: operation.createdAt * 1000,
        terms: operation.target.offer.terms,
      }),
    );
  }
  getMockStore().billingChangeOperations.set(
    `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
    operation,
  );
  f.renewal.parent = {
    type: "subscription_details",
    quote_details: null,
    subscription_details: {
      subscription: f.subscription.id,
      metadata: { chronote_change_operation: operation.operationId },
    },
  };
  getMockStore().billingChangeControls.set(
    `CHANGE_CONTROL#${operation.guildId}`,
    { operationId: operation.operationId },
  );
  return { f, operation };
}
test.each([
  [false, true],
  [true, true],
  [false, false],
  [true, false],
] as const)(
  "cancels an applied unpaid schedule and releases its old operation control (offer=%s, enforcement=%s)",
  async (withOffer, enforcement) => {
    config.stripe.renewalGraceEnabled = enforcement;
    const { f, operation } = await scheduledFixture(withOffer);
    const grace = await f.refresh();
    if (!grace || grace.state !== "grace") throw new Error("Expected grace");
    const payer = jest
      .spyOn(renewalPayer, "assertStripePayer")
      .mockResolvedValue();
    const provider = jest
      .spyOn(renewalProvider, "cancelUnpaidRenewal")
      .mockImplementation(async (input) => {
        if (input.recovery.state !== "canceling")
          throw new Error("Expected cancellation");
        f.subscription.status = "canceled";
        f.subscription.metadata.chronote_renewal_recovery = renewalRecoveryKey(
          input.recovery,
        );
        await input.onReceipt({
          ...input.recovery,
          revision: "native-canceled",
          receipts: {
            ...input.recovery.receipts,
            creditNoteId: "cn_owned",
            canceled: true,
            collectionRestored: true,
            collectionToRestore: [],
          },
        });
        return "canceled";
      });
    try {
      const result = await cancelBillingChange({
        stripe: f.stripe,
        guildId: operation.guildId,
        payerId: operation.payerId,
        operationId: operation.operationId,
        now: paidEndsAt + 4001,
      });
      expect(result).toMatchObject({ state: "canceled" });
      if (withOffer)
        expect(
          getMockStore().offerUsages.get(
            offerUsageKey(operation.guildId, "basic_intro_v1", "test"),
          ),
        ).toMatchObject({
          state: "unused",
          released: {
            reason: "schedule_canceled",
            operationId: operation.operationId,
          },
        });
      expect(
        await classifyChangeHistory(f.renewal, {
          guildId: operation.guildId,
          mode: "test",
          accountId: "acct_owned",
          createdBefore: paidEndsAt + 8000,
        }),
      ).toEqual({ kind: "ordinary" });
      expect(
        getMockStore().billingChangeOperations.get(
          `CHANGE_OP#${operation.guildId}#${operation.operationId}`,
        ),
      ).toMatchObject({ state: "canceled", reconciled: true });
      expect(
        getMockStore().billingChangeControls.has(
          `CHANGE_CONTROL#${operation.guildId}`,
        ),
      ).toBe(false);
      expect(
        getMockStore().renewalRecoveryPointers.get(operation.guildId)?.blocking,
      ).toBe(false);
      expect(
        await getRenewalRecoveryRepository().getCurrent(operation.guildId),
      ).toMatchObject({
        state: "canceled",
        endsAt: grace.endsAt,
        enforcementAccepted: enforcement,
      });
      if (!enforcement)
        expect(
          await resolveRenewalAccess(
            getMockStore().subscriptions.get(operation.guildId),
            paidEndsAt + 4002,
          ),
        ).toBeUndefined();
    } finally {
      payer.mockRestore();
      provider.mockRestore();
    }
  },
);

test.each(["observation", "paid_basis"] as const)(
  "expands the reserved scheduled offer evidence during %s",
  async (path) => {
    const { readRenewalPaidBasis } =
      await import("../../src/services/renewalRecoveryEvidence");
    const { f, operation } = await scheduledFixture(true);
    f.requireCouponExpansion();
    await f.refresh();
    const discount = {
      ...remainingDiscount,
      id: "di_owned_offer",
      source: { type: "coupon" as const, coupon: "co_monthly" },
    };
    f.renewal.status = "paid";
    f.renewal.amount_remaining = 0;
    f.renewal.amount_paid = 600;
    f.renewal.amount_due = 600;
    f.renewal.total = 600;
    f.renewal.discounts = [discount];
    f.renewal.total_discount_amounts = [{ amount: 400, discount: discount.id }];
    f.renewal.lines.data[0].discount_amounts = [
      { amount: 400, discount: discount.id },
    ];
    if (path === "observation")
      expect(await f.refresh()).toMatchObject({ state: "paid" });
    else
      expect(
        await readRenewalPaidBasis(
          f.stripe,
          f.subscription,
          operation.guildId,
          f.renewal.id,
        ),
      ).toMatchObject({ invoiceId: f.renewal.id, tier: "basic" });
  },
);

test("does not adopt or grant an underpaid scheduled target through renewal recovery", async () => {
  const { readRenewalPaidBasis } =
    await import("../../src/services/renewalRecoveryEvidence");
  const { f, operation } = await scheduledFixture();
  operation.target.unitAmount = 1000;
  await f.refresh();
  f.renewal.status = "paid";
  f.renewal.amount_remaining = 0;
  f.renewal.amount_paid = 800;
  f.renewal.total = 800;
  f.renewal.total_discount_amounts = [
    { amount: 200, discount: "di_unreviewed" },
  ];
  f.renewal.lines.data[0].invoice = f.renewal.id;
  f.renewal.lines.data[0].discount_amounts = [
    { amount: 200, discount: "di_unreviewed" },
  ];
  await expect(f.refresh()).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    readRenewalPaidBasis(
      f.stripe,
      f.subscription,
      operation.guildId,
      f.renewal.id,
    ),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(
    await getRenewalRecoveryRepository().getCurrent(operation.guildId),
  ).toMatchObject({ state: "grace" });
});

test("billing status exposes the same verified invoice only to the original payer", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  f.renewal.hosted_invoice_url = "https://invoice.stripe.com/i/owned";
  const grace = await f.refresh();
  if (!grace || grace.state !== "grace") throw new Error("Expected grace");
  const input = {
    stripe: f.stripe,
    guildId: grace.guildId,
    now: paidEndsAt + 4001,
  };
  expect(
    await getRenewalRecoveryView({ ...input, payerId: grace.payerId }),
  ).toMatchObject({
    status: "grace",
    priorTier: "basic",
    selectedTier: "basic",
    amountDue: 1000,
    paymentUrl: f.renewal.hosted_invoice_url,
    canManage: true,
  });
  const other = await getRenewalRecoveryView({
    ...input,
    payerId: "another-payer",
  });
  expect(other).toMatchObject({
    status: "grace",
    paymentUrl: null,
    canManage: false,
  });
  expect(other).not.toHaveProperty("subscriptionId");
  expect(other).not.toHaveProperty("invoiceId");
});
test("billing status names the selected Basic plan separately from prior Pro access", async () => {
  const { f, operation } = await scheduledFixture();
  await f.refresh();
  expect(
    await getRenewalRecoveryView({
      stripe: f.stripe,
      guildId: operation.guildId,
      payerId: operation.payerId,
      now: paidEndsAt + 4001,
    }),
  ).toMatchObject({
    status: "grace",
    priorTier: "pro",
    selectedTier: "basic",
    scheduledChange: true,
  });
});
test("billing status hides the payment URL after cancellation starts and at expiry", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace || grace.state !== "grace") throw new Error("Expected grace");
  expect(
    await getRenewalRecoveryView({
      stripe: f.stripe,
      guildId: grace.guildId,
      payerId: grace.payerId,
      now: grace.endsAt,
    }),
  ).toMatchObject({ status: "reconciling", paymentUrl: null });
  const provider = jest
    .spyOn(renewalProvider, "cancelUnpaidRenewal")
    .mockRejectedValue(new Error("Provider unavailable"));
  try {
    await expect(
      reconcileRenewalRecovery({
        stripe: f.stripe,
        guildId: grace.guildId,
        now: grace.endsAt,
      }),
    ).rejects.toThrow();
    expect(
      await getRenewalRecoveryView({
        stripe: f.stripe,
        guildId: grace.guildId,
        payerId: grace.payerId,
        now: grace.endsAt,
      }),
    ).toMatchObject({ status: "reconciling", paymentUrl: null });
  } finally {
    provider.mockRestore();
  }
});

test("disabled coverage binds the original deadline without access enforcement or financial cleanup", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  config.stripe.renewalGraceEnabled = false;
  const record = await f.refresh();
  if (!record || record.state !== "grace")
    throw new Error("Expected bound coverage");
  const provider = jest.spyOn(renewalProvider, "cancelUnpaidRenewal");
  await reconcileRenewalRecovery({
    stripe: f.stripe,
    guildId: record.guildId,
    now: record.endsAt + 500,
  });
  expect(provider).not.toHaveBeenCalled();
  provider.mockRestore();
  config.stripe.renewalGraceEnabled = true;
  expect(await f.refresh(record.endsAt + 1000)).toMatchObject({
    state: "grace",
    enforcementAccepted: true,
    endsAt: record.endsAt,
  });
});

test("the normal paid writer records coverage before acknowledgment while enforcement is off", async () => {
  const f = fixture();
  config.stripe.renewalGraceEnabled = false;
  await reconcileSubscription(
    f.stripe,
    renewalSubscription.guildId,
    f.subscription.id,
  );
  expect(
    await getRenewalRecoveryRepository().getCurrent(
      renewalSubscription.guildId,
    ),
  ).toMatchObject({
    state: "watching",
    writerVersion: "renewal-grace-v1",
    enforcementAccepted: false,
    paid: { invoiceId: fundedInvoice.id },
  });
});

test("a credit-note-paid invoice cannot project active service during cancellation", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace || grace.state !== "grace") throw new Error("Expected grace");
  const provider = jest
    .spyOn(renewalProvider, "cancelUnpaidRenewal")
    .mockRejectedValue(new Error("Cancellation unavailable"));
  try {
    await expect(
      reconcileRenewalRecovery({
        stripe: f.stripe,
        guildId: grace.guildId,
        now: grace.endsAt,
      }),
    ).rejects.toThrow();
  } finally {
    provider.mockRestore();
  }
  const previous = { ...getMockStore().subscriptions.get(grace.guildId) };
  f.subscription.status = "active";
  f.renewal.status = "paid";
  f.renewal.amount_remaining = 0;
  f.renewal.pre_payment_credit_notes_amount = 1000;
  await reconcileSubscription(f.stripe, grace.guildId, grace.subscriptionId);
  expect(getMockStore().subscriptions.get(grace.guildId)).toEqual(previous);
});

test("an in-flight renewal payment exposes a quiet settlement state without retry or paid access", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const grace = await f.refresh();
  if (!grace) throw new Error("Expected grace");
  f.processing(true);
  expect(
    await getRenewalRecoveryView({
      stripe: f.stripe,
      guildId: grace.guildId,
      payerId: grace.payerId,
      now: paidEndsAt + 4001,
    }),
  ).toMatchObject({ status: "settlement_pending", paymentUrl: null });
  expect(
    (await getRenewalRecoveryRepository().getCurrent(grace.guildId))?.state,
  ).toBe("grace");
  f.processing(false);
  expect(
    await getRenewalRecoveryView({
      stripe: f.stripe,
      guildId: grace.guildId,
      payerId: grace.payerId,
      now: paidEndsAt + 4002,
    }),
  ).toMatchObject({ status: "grace" });
});

test("tracks the paid Pro upgrade even when its renewal date is unchanged", async () => {
  const f = fixture();
  await f.track();
  const item = f.subscription.items.data[0];
  item.price.id = "price_upgraded_pro";
  item.price.lookup_key = "chronote_pro_monthly";
  const invoice = {
    ...fundedInvoice,
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
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
  invoice.id = "in_upgrade";
  invoice.lines.data[0].invoice = invoice.id;
  const pricing = invoice.lines.data[0].pricing?.price_details;
  if (!pricing) throw new Error("Missing fixture pricing");
  pricing.price = item.price.id;
  f.invoices.set(invoice.id, invoice);
  f.subscription.latest_invoice = invoice.id;
  await trackPaidRenewalPeriod({
    stripe: f.stripe,
    guildId: renewalSubscription.guildId,
    subscriptionId: f.subscription.id,
    invoiceId: invoice.id,
    now: paidEndsAt - 100,
  });
  expect(
    await getRenewalRecoveryRepository().getCurrent(
      renewalSubscription.guildId,
    ),
  ).toMatchObject({
    state: "watching",
    paid: {
      tier: "pro",
      priceId: item.price.id,
      invoiceId: invoice.id,
      periodEnd: paidEndsAt,
    },
  });
});

test("retries a concurrent registration using fresh ownership and paid proof", async () => {
  const f = fixture();
  const repository =
    await import("../../src/repositories/renewalRecoveryRepository");
  const repo = repository.getRenewalRecoveryRepository();
  const register = jest
    .fn()
    .mockResolvedValueOnce(false)
    .mockImplementation(repo.register);
  const spy = jest
    .spyOn(repository, "getRenewalRecoveryRepository")
    .mockReturnValue({ ...repo, register });
  try {
    await expect(f.track()).resolves.toBeUndefined();
    expect(register).toHaveBeenCalledTimes(2);
    expect(await repo.getCurrent(renewalSubscription.guildId)).toMatchObject({
      state: "watching",
    });
  } finally {
    spy.mockRestore();
  }
});

test.each(["paid", "open"] as const)(
  "catches up an old watch to the latest verified paid basis before the current %s renewal",
  async (status) => {
    const f = fixture();
    await f.track();
    f.fail();
    f.renewal.status = "paid";
    f.renewal.amount_remaining = 0;
    f.renewal.amount_paid = 1000;
    const start = f.renewal.lines.data[0].period.end;
    const current = {
      ...f.renewal,
      id: "in_second_renewal",
      status,
      amount_paid: status === "paid" ? 1000 : 0,
      amount_remaining: status === "paid" ? 0 : 1000,
      created: start,
      status_transitions: {
        ...f.renewal.status_transitions,
        finalized_at: start,
      },
      lines: {
        ...f.renewal.lines,
        data: f.renewal.lines.data.map((line) => ({
          ...line,
          id: "il_second",
          invoice: "in_second_renewal",
          period: { start, end: start + 2592000 },
        })),
      },
    };
    f.invoices.set(current.id, current);
    f.subscription.latest_invoice = current.id;
    f.subscription.status = status === "paid" ? "active" : "past_due";
    f.subscription.items.data[0].current_period_start = start;
    f.subscription.items.data[0].current_period_end = start + 2592000;
    expect(await f.refresh(start + 10)).toMatchObject(
      status === "paid"
        ? {
            state: "watching",
            paid: { invoiceId: current.id, periodEnd: start + 2592000 },
          }
        : {
            state: "grace",
            paid: { invoiceId: f.renewal.id, periodEnd: start },
            endsAt: start + 172800,
          },
    );
    expect(
      (
        await getRenewalRecoveryRepository().listDue({
          mode: "test",
          now: start + 172800,
          limit: 100,
        })
      ).keys,
    ).toHaveLength(status === "paid" ? 0 : 1);
  },
);

test("finishes old compensation while preserving newer paid service and replacing the due watch", async () => {
  const f = fixture();
  await f.track();
  f.fail();
  const original = await f.refresh();
  if (!original) throw new Error("Missing recovery");
  const item = f.subscription.items.data[0];
  const start = item.current_period_end;
  const current = {
    ...fundedInvoice,
    id: "in_paid_after_recovery",
    created: start,
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        invoice: "in_paid_after_recovery",
        period: { start, end: start + 2592000 },
      })),
    },
  };
  f.invoices.set(current.id, current);
  f.subscription.status = "active";
  f.subscription.latest_invoice = current.id;
  item.current_period_start = start;
  item.current_period_end = start + 2592000;
  const paid = {
    invoiceId: current.id,
    priceId: item.price.id,
    tier: "basic" as const,
    interval: "month" as const,
    periodStart: start,
    periodEnd: item.current_period_end,
  };
  const cancel = jest
    .spyOn(renewalProvider, "cancelUnpaidRenewal")
    .mockImplementation(async (input) => {
      if (input.recovery.state !== "canceling")
        throw new Error("Expected cancellation");
      await input.onReceipt({
        ...input.recovery,
        revision: "native-receipt",
        receipts: {
          ...input.recovery.receipts,
          creditNoteId: "cn_native",
          canceled: false,
          collectionRestored: true,
          collectionToRestore: [],
        },
      });
      return { kind: "superseded", paid };
    });
  try {
    await cancelRenewalRecovery({
      stripe: f.stripe,
      guildId: renewalSubscription.guildId,
      payerId: f.subscription.metadata.discord_id,
      now: start + 10,
    });
    const repo = getRenewalRecoveryRepository();
    expect(await repo.get(renewalRecoveryKey(original))).toMatchObject({
      state: "superseded",
      projection: { state: "complete" },
      replacementPaid: paid,
      receipts: { canceled: false, creditNoteId: "cn_native" },
    });
    expect(await repo.getCurrent(original.guildId)).toMatchObject({
      state: "watching",
      paid,
    });
    const saved = getMockStore().subscriptions.get(original.guildId);
    expect(saved?.status).toBe("active");
    expect(await resolveRenewalAccess(saved, start + 10)).toMatchObject({
      tier: "basic",
      expiresAt: paid.periodEnd * 1000,
    });
    await reconcileRenewalRecovery({
      stripe: f.stripe,
      guildId: original.guildId,
      now: start + 20,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  } finally {
    cancel.mockRestore();
  }
});

test.each(["paid", "open"] as const)(
  "repairs a paid projection after the provider has advanced to another %s period",
  async (status) => {
    const f = fixture();
    await f.track();
    f.fail();
    await f.refresh();
    f.renewal.status = "paid";
    f.renewal.amount_paid = 1000;
    f.renewal.amount_remaining = 0;
    expect(await f.refresh()).toMatchObject({
      state: "paid",
      projection: { state: "pending" },
    });
    const item = f.subscription.items.data[0];
    const start = item.current_period_end;
    const current = {
      ...f.renewal,
      id: "in_later_projection",
      created: start,
      status,
      amount_paid: status === "paid" ? 1000 : 0,
      amount_remaining: status === "paid" ? 0 : 1000,
      status_transitions: {
        ...f.renewal.status_transitions,
        finalized_at: start,
      },
      lines: {
        ...f.renewal.lines,
        data: f.renewal.lines.data.map((line) => ({
          ...line,
          invoice: "in_later_projection",
          period: { start, end: start + 2592000 },
        })),
      },
    };
    f.invoices.set(current.id, current);
    f.subscription.latest_invoice = current.id;
    f.subscription.status = status === "paid" ? "active" : "past_due";
    item.current_period_start = start;
    item.current_period_end = start + 2592000;
    await expect(
      reconcileRenewalRecovery({
        stripe: f.stripe,
        guildId: renewalSubscription.guildId,
        now: start + 10,
      }),
    ).resolves.toBeUndefined();
    expect(
      await getRenewalRecoveryRepository().getCurrent(
        renewalSubscription.guildId,
      ),
    ).toMatchObject(
      status === "paid"
        ? { state: "watching", paid: { invoiceId: current.id } }
        : {
            state: "grace",
            paid: { invoiceId: f.renewal.id },
            endsAt: start + 172800,
          },
    );
  },
);
