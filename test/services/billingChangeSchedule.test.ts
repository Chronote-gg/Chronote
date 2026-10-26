/** @jest-environment node */
import {
  buildChangeSchedulePhases,
  cancelChangeSchedule,
  scheduleBillingChange,
  readScheduledChangeSettlement,
} from "../../src/services/billingChangeSchedule";
import {
  sourceSubscription,
  remainingDiscount,
} from "../fixtures/renewalStripe";
import { changeOperation } from "../fixtures/billingChange";
import { billingChangeBase } from "../../src/types/billingChange";
const operation = {
  ...billingChangeBase(changeOperation),
  timing: "renewal" as const,
  state: "accepted" as const,
  funding: null,
  consent: { at: 1700000001, quoteRevision: "reviewed" },
  target: {
    ...changeOperation.target,
    selection: {
      tier: "basic" as const,
      interval: "month" as const,
      expectedOffer: "none" as const,
    },
  },
};
it("keeps the paid phase and original discount identity until renewal", () => {
  const phases = buildChangeSchedulePhases(
    { ...sourceSubscription, discounts: [remainingDiscount] },
    operation,
  );
  expect(phases[0]).toMatchObject({
    start_date: operation.source.periodStart,
    end_date: operation.source.periodEnd,
    items: [{ price: operation.source.priceId, quantity: 1 }],
    discounts: [{ discount: remainingDiscount.id }],
    proration_behavior: "none",
  });
  expect(phases[1]).toMatchObject({
    start_date: operation.source.periodEnd,
    items: [{ price: operation.target.priceId, quantity: 1 }],
    discounts: "",
    proration_behavior: "none",
  });
});
it("reserves the unused monthly offer for three months without restarting the current coupon", () => {
  const terms = {
    priceId: "price_basic_month",
    couponId: "co_new_month",
    currency: "usd" as const,
    interval: "month" as const,
    regularUnitAmount: 1000 as const,
    discountedUnitAmount: 600 as const,
    durationMonths: 3 as const,
  };
  const next = {
    ...operation,
    target: {
      ...operation.target,
      offer: {
        id: "basic_intro_v1" as const,
        terms,
        authority: {
          guildId: operation.guildId,
          mode: "test" as const,
          offerId: "basic_intro_v1" as const,
          accountId: "acct-owned",
          coverageRevision: "coverage",
          boundaryRevision: "boundary",
          writerImageDigest: "sha256:" + "a".repeat(64),
        },
      },
    },
  };
  const phases = buildChangeSchedulePhases(sourceSubscription, next);
  expect(phases[1]).toMatchObject({
    discounts: [{ coupon: "co_new_month" }],
    duration: { interval: "month", interval_count: 3 },
  });
  expect(phases[0].discounts).toBe("");
});

import { stripeTransport } from "../fixtures/stripeTransport";
import {
  changeServiceFingerprint,
  changeSourceFingerprint,
} from "../../src/services/billingChangeProvider";
it("does not return an offer reservation when a released schedule has already changed the plan", async () => {
  const scheduled = {
    ...operation,
    state: "scheduled" as const,
    scheduleId: "sub_sched_owned",
  };
  const native = {
    ...sourceSubscription,
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    metadata: { guild_id: operation.guildId },
    items: {
      ...sourceSubscription.items,
      data: [
        {
          ...sourceSubscription.items.data[0],
          id: operation.source.itemId,
          price: {
            ...sourceSubscription.items.data[0].price,
            id: operation.target.priceId ?? "",
          },
        },
      ],
    },
  };
  const schedule = {
    id: "sub_sched_owned",
    status: "active",
    livemode: false,
    customer: operation.source.customerId,
    subscription: operation.source.subscriptionId,
    metadata: { chronote_change_operation: operation.operationId },
  };
  const f = stripeTransport(({ path, method }) => {
    if (path.endsWith("/release") && method === "POST")
      return {
        ...schedule,
        status: "released",
        released_subscription: native.id,
      };
    if (path === "/v1/subscription_schedules/sub_sched_owned") return schedule;
    if (path === `/v1/subscriptions/${native.id}`) return native;
    throw new Error(`Unexpected ${method} ${path}`);
  });
  expect(
    await cancelChangeSchedule(f.stripe, scheduled, scheduled.scheduleId),
  ).toBe(false);
});
it("validates schedule ownership before clearing an existing cancellation", async () => {
  const native = {
    ...sourceSubscription,
    schedule: "sub_sched_foreign",
    cancel_at: operation.source.periodEnd,
    items: {
      ...sourceSubscription.items,
      data: [
        {
          ...sourceSubscription.items.data[0],
          id: operation.source.itemId,
          price: {
            ...sourceSubscription.items.data[0].price,
            id: operation.source.priceId,
          },
          current_period_start: operation.source.periodStart,
          current_period_end: operation.source.periodEnd,
        },
      ],
    },
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    metadata: { guild_id: operation.guildId },
  };
  const selected = {
    ...operation,
    createdAt: Math.floor(Date.now() / 1000),
    source: {
      ...operation.source,
      invariantFingerprint: changeServiceFingerprint(native),
    },
  };
  const f = stripeTransport(({ path }) => {
    if (path === `/v1/subscriptions/${native.id}`) return native;
    if (path === "/v1/subscription_schedules/sub_sched_foreign")
      return {
        id: "sub_sched_foreign",
        livemode: false,
        subscription: native.id,
        metadata: { chronote_change_operation: "another-operation" },
      };
    throw new Error(`Unexpected request ${path}`);
  });
  await expect(scheduleBillingChange(f.stripe, selected)).rejects.toThrow();
  expect(
    f.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(0);
});

it("creates from a subscription without unsupported metadata, then marks the owned schedule", async () => {
  const native = {
    ...sourceSubscription,
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    metadata: { guild_id: operation.guildId },
    schedule: null,
    cancel_at: operation.source.periodEnd,
    cancel_at_period_end: true,
    items: {
      ...sourceSubscription.items,
      data: [
        {
          ...sourceSubscription.items.data[0],
          id: operation.source.itemId,
          price: {
            ...sourceSubscription.items.data[0].price,
            id: operation.source.priceId,
          },
          current_period_start: operation.source.periodStart,
          current_period_end: operation.source.periodEnd,
        },
      ],
    },
  };
  const selected = {
    ...operation,
    createdAt: Math.floor(Date.now() / 1000),
    source: {
      ...operation.source,
      fingerprint: changeSourceFingerprint(native),
      invariantFingerprint: changeServiceFingerprint(native),
    },
  };
  const schedule = {
    id: "sub_sched_new",
    customer: operation.source.customerId,
    livemode: false,
    subscription: native.id,
    metadata: {},
  };
  const f = stripeTransport(({ path, method, fields }) => {
    if (path === `/v1/subscriptions/${native.id}`) return native;
    if (path === "/v1/subscription_schedules" && method === "POST") {
      expect(fields.has("metadata[chronote_change_operation]")).toBe(false);
      return schedule;
    }
    if (
      path === "/v1/subscription_schedules/sub_sched_new" &&
      method === "POST"
    )
      return {
        ...schedule,
        metadata: { chronote_change_operation: operation.operationId },
        phases: [
          {},
          {
            start_date: operation.source.periodEnd,
            items: [{ price: operation.target.priceId }],
          },
        ],
      };
    throw new Error(`Unexpected ${method} ${path}`);
  });
  expect(await scheduleBillingChange(f.stripe, selected)).toBe(schedule.id);
  expect(
    f.requests.filter(
      (r) => r.method === "POST" && r.path === `/v1/subscriptions/${native.id}`,
    ),
  ).toHaveLength(0);
});

it.each([
  "regular",
  "line_discount",
  "invoice_discount",
  "net_total",
  "pending_item",
  "exclusive_tax",
  "account_credit",
] as const)(
  "settles only the frozen non-offer renewal price (%s)",
  async (variant) => {
    const scheduled = {
      ...operation,
      state: "scheduled" as const,
      scheduleId: "sub_sched_owned",
    };
    const item = {
      ...sourceSubscription.items.data[0],
      id: "si_new_target",
      price: {
        ...sourceSubscription.items.data[0].price,
        id: operation.target.priceId ?? "",
      },
      current_period_start: operation.source.periodEnd,
      current_period_end: operation.source.periodEnd + 30 * 86400,
    };
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      metadata: {
        guild_id: operation.guildId,
        chronote_change_operation: operation.operationId,
      },
      items: { ...sourceSubscription.items, data: [item] },
      latest_invoice: "in_scheduled",
    };
    const original = (await import("../fixtures/renewalStripe")).fundedInvoice;
    const invoice = {
      ...original,
      id: "in_scheduled",
      customer: operation.source.customerId,
      subtotal: operation.target.unitAmount,
      total: operation.target.unitAmount,
      amount_due: operation.target.unitAmount,
      amount_paid: operation.target.unitAmount,
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: native.id,
          metadata: {
            guild_id: operation.guildId,
            chronote_change_operation: operation.operationId,
          },
        },
      },
      lines: {
        ...original.lines,
        data: [
          {
            ...original.lines.data[0],
            invoice: "in_scheduled",
            amount: operation.target.unitAmount,
            quantity: 1,
            period: {
              start: operation.source.periodEnd,
              end: item.current_period_end,
            },
            pricing: { price_details: { price: operation.target.priceId } },
            parent: {
              subscription_item_details: {
                subscription: native.id,
                subscription_item: item.id,
              },
            },
          },
        ],
      },
    };
    const service = invoice.lines.data[0];
    if (variant === "line_discount")
      service.discount_amounts = [{ discount: "di_unexpected", amount: 400 }];
    if (variant === "invoice_discount") {
      invoice.discounts = ["di_unexpected"];
      invoice.total_discount_amounts = [
        { discount: "di_unexpected", amount: 400 },
      ];
    }
    if (["line_discount", "invoice_discount", "net_total"].includes(variant)) {
      invoice.total -= 400;
      invoice.amount_paid -= 400;
      invoice.amount_due -= 400;
    }
    if (variant === "exclusive_tax") {
      service.taxes = [
        {
          amount: 168,
          tax_behavior: "exclusive",
          taxable_amount: service.amount,
          type: "tax_rate_details",
          tax_rate_details: { tax_rate: "txr_owned" },
        },
      ];
      invoice.total += 168;
      invoice.amount_paid += 168;
      invoice.amount_due += 168;
    }
    if (variant === "account_credit") {
      invoice.starting_balance = -400;
      invoice.amount_paid -= 400;
      invoice.amount_due -= 400;
    }
    const pending = {
      ...service,
      id: "il_unrelated",
      amount: 200,
      parent: {
        type: "invoice_item_details",
        invoice_item_details: { invoice_item: "ii_owned", proration: false },
      },
    };
    if (variant === "pending_item") {
      invoice.subtotal += 200;
      invoice.total += 200;
      invoice.amount_paid += 200;
      invoice.amount_due += 200;
    }
    const nativeInvoice =
      variant === "pending_item"
        ? { ...invoice, lines: { ...invoice.lines, data: [service, pending] } }
        : invoice;
    const schedule = {
      id: "sub_sched_owned",
      status: "active",
      livemode: false,
      customer: operation.source.customerId,
      subscription: native.id,
      metadata: { chronote_change_operation: operation.operationId },
    };
    const f = stripeTransport(({ path }) => {
      if (path === `/v1/subscriptions/${native.id}`) return native;
      if (path === "/v1/invoices/in_scheduled") return nativeInvoice;
      if (path === "/v1/invoices")
        return { object: "list", data: [], has_more: false };
      if (path.endsWith("/release"))
        return {
          ...schedule,
          status: "released",
          released_subscription: native.id,
        };
      if (path === "/v1/subscription_schedules/sub_sched_owned")
        return schedule;
      throw new Error(`Unexpected ${path}`);
    });
    expect(
      await readScheduledChangeSettlement(f.stripe, scheduled),
    ).toMatchObject({
      kind: ["line_discount", "invoice_discount", "net_total"].includes(variant)
        ? "waiting"
        : "paid",
    });
  },
);

it.each([
  [true, "subscription_cycle", "none"],
  [false, "subscription_cycle", "none"],
  [true, "subscription_update", "none"],
  [false, "subscription_update", "none"],
  [true, "subscription_cycle", "pre"],
  [true, "subscription_cycle", "post"],
] as const)(
  "settles a paid scheduled offer with a separate pending invoice item: valid discount %s, reason %s",
  async (valid, reason, credit) => {
    const terms = {
      interval: "month" as const,
      currency: "usd" as const,
      priceId: "price_basic_month",
      couponId: "co_scheduled",
      regularUnitAmount: 1000 as const,
      discountedUnitAmount: 600 as const,
      durationMonths: 3 as const,
    };
    const selected = {
      ...operation,
      state: "scheduled" as const,
      scheduleId: null,
      target: {
        ...operation.target,
        priceId: terms.priceId,
        unitAmount: 1000,
        selection: {
          tier: "basic" as const,
          interval: "month" as const,
          expectedOffer: "basic_intro_v1" as const,
        },
        offer: {
          id: "basic_intro_v1" as const,
          terms,
          authority: {
            guildId: operation.guildId,
            mode: "test" as const,
            offerId: "basic_intro_v1" as const,
            accountId: "acct-owned",
            coverageRevision: "coverage",
            boundaryRevision: "boundary",
            writerImageDigest: "sha256:" + "a".repeat(64),
          },
        },
      },
    };
    const original = (await import("../fixtures/renewalStripe")).fundedInvoice;
    const discount = {
      ...remainingDiscount,
      id: "di_scheduled",
      source: { type: "coupon", coupon: terms.couponId },
    };
    const service = {
      ...original.lines.data[0],
      id: "il_service",
      invoice: "in_scheduled",
      amount: 1000,
      quantity: 1,
      period: {
        start: operation.source.periodEnd,
        end: operation.source.periodEnd + 30 * 86400,
      },
      pricing: { price_details: { price: terms.priceId } },
      discount_amounts: [{ discount: discount.id, amount: valid ? 400 : 200 }],
      parent: {
        type: "subscription_item_details",
        subscription_item_details: {
          subscription: operation.source.subscriptionId,
          subscription_item: "si_new",
          proration: false,
        },
      },
    };
    const pending = {
      ...original.lines.data[0],
      id: "il_pending",
      invoice: "in_scheduled",
      amount: 200,
      pricing: { price_details: { price: terms.priceId } },
      discount_amounts: [],
      parent: {
        type: "invoice_item_details",
        invoice_item_details: { invoice_item: "ii_pending", proration: false },
      },
    };
    const invoice = {
      ...original,
      id: "in_scheduled",
      customer: operation.source.customerId,
      billing_reason: reason,
      pre_payment_credit_notes_amount: credit === "pre" ? 100 : 0,
      post_payment_credit_notes_amount: credit === "post" ? 100 : 0,
      subtotal: 1200,
      total: 800,
      amount_due: 800,
      amount_paid: 800,
      amount_remaining: 0,
      discounts: [discount],
      total_discount_amounts: [{ discount: discount.id, amount: 400 }],
      parent: {
        type: "subscription_details",
        subscription_details: {
          subscription: operation.source.subscriptionId,
          metadata: { chronote_change_operation: operation.operationId },
        },
      },
      lines: { ...original.lines, data: [pending, service] },
    };
    const native = {
      ...sourceSubscription,
      id: operation.source.subscriptionId,
      customer: operation.source.customerId,
      metadata: {
        guild_id: operation.guildId,
        chronote_change_operation: operation.operationId,
      },
      latest_invoice: invoice.id,
    };
    const { stripeTransport } = await import("../fixtures/stripeTransport");
    const f = stripeTransport(({ path }) => {
      if (path.includes("subscriptions/")) return native;
      if (path === "/v1/invoices/in_scheduled") return invoice;
      if (path === "/v1/invoices")
        return { object: "list", has_more: false, data: [] };
      throw Error(`Unexpected ${path}`);
    });
    expect(
      await readScheduledChangeSettlement(f.stripe, selected),
    ).toMatchObject({ kind: valid && credit === "none" ? "paid" : "waiting" });
  },
);

function recoveryFixture() {
  const native = {
    ...sourceSubscription,
    id: operation.source.subscriptionId,
    customer: operation.source.customerId,
    metadata: { guild_id: operation.guildId },
    cancel_at: null,
    cancel_at_period_end: false,
    schedule: "sub_sched_recovery",
    items: {
      ...sourceSubscription.items,
      data: [
        {
          ...sourceSubscription.items.data[0],
          id: operation.source.itemId,
          price: {
            ...sourceSubscription.items.data[0].price,
            id: operation.source.priceId,
          },
          current_period_start: operation.source.periodStart,
          current_period_end: operation.source.periodEnd,
        },
      ],
    },
  };
  const selected = {
    ...operation,
    createdAt: Math.floor(Date.now() / 1000) - 25 * 3600,
    source: {
      ...operation.source,
      fingerprint: changeSourceFingerprint(native),
      invariantFingerprint: changeServiceFingerprint(native),
    },
  };
  const schedule = {
    id: native.schedule,
    customer: native.customer,
    subscription: native.id,
    livemode: false,
    status: "active",
    metadata: {},
  };
  return { native, selected, schedule };
}
it.each([true, false])(
  "recovers an old unmarked schedule only with its exact creation request: owned %s",
  async (owned) => {
    const { native, selected, schedule } = recoveryFixture();
    const saved = jest.fn();
    const f = stripeTransport(({ path, method }) => {
      if (path === `/v1/subscriptions/${native.id}`) return native;
      if (path === "/v1/events")
        return {
          object: "list",
          has_more: false,
          data: [
            {
              id: "evt_created",
              type: "subscription_schedule.created",
              livemode: false,
              request: {
                id: "req_created",
                idempotency_key: owned
                  ? `chronote_change_test_${operation.operationId}_create-schedule`
                  : "foreign-key",
              },
              data: { object: schedule },
            },
          ],
        };
      if (
        path === `/v1/subscription_schedules/${schedule.id}` &&
        method === "POST"
      )
        return {
          ...schedule,
          metadata: { chronote_change_operation: operation.operationId },
          phases: [
            {},
            {
              start_date: operation.source.periodEnd,
              items: [{ price: operation.target.priceId }],
            },
          ],
        };
      if (path === `/v1/subscription_schedules/${schedule.id}`) return schedule;
      throw Error(`Unexpected ${method} ${path}`);
    });
    if (owned) {
      expect(await scheduleBillingChange(f.stripe, selected, saved)).toBe(
        schedule.id,
      );
      expect(saved).toHaveBeenCalledWith(schedule.id);
      expect(
        f.requests
          .filter((r) => r.method === "POST")
          .every((r) => r.path !== "/v1/subscription_schedules"),
      ).toBe(true);
    } else {
      await expect(
        scheduleBillingChange(f.stripe, selected, saved),
      ).rejects.toThrow();
      expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
    }
  },
);
it.each(["classic", "flexible"] as const)(
  "restores the original requested cancellation after abandoning a paid schedule in %s",
  async (mode) => {
    const { native, selected, schedule } = recoveryFixture();
    const scheduled = {
      ...selected,
      state: "scheduled" as const,
      scheduleId: schedule.id,
      source: {
        ...selected.source,
        billingMode: mode,
        cancellation: {
          at: selected.source.periodEnd,
          atPeriodEnd: mode === "classic",
        },
      },
    };
    const owned = {
      ...schedule,
      metadata: { chronote_change_operation: operation.operationId },
    };
    const f = stripeTransport(({ path, method, fields }) => {
      if (path.endsWith("/release")) {
        expect(fields.get("preserve_cancel_date")).toBe("true");
        return {
          ...owned,
          status: "released",
          released_subscription: native.id,
        };
      }
      if (path === `/v1/subscription_schedules/${schedule.id}`) return owned;
      if (path === `/v1/subscriptions/${native.id}` && method === "POST") {
        expect(fields.get("proration_behavior")).toBe("none");
        return {
          ...native,
          cancel_at: selected.source.periodEnd,
          cancel_at_period_end: mode === "classic",
        };
      }
      if (path === `/v1/subscriptions/${native.id}`) return native;
      throw Error(`Unexpected ${method} ${path}`);
    });
    expect(await cancelChangeSchedule(f.stripe, scheduled, schedule.id)).toBe(
      true,
    );
    expect(
      f.requests.some(
        (r) =>
          r.path === `/v1/subscriptions/${native.id}` && r.method === "POST",
      ),
    ).toBe(true);
  },
);

it("uses its durable creation receipt after idempotency expiry before any other write", async () => {
  const { native, selected, schedule } = recoveryFixture();
  const saved = jest.fn().mockRejectedValue(Error("receipt write unavailable"));
  const f = stripeTransport(({ path }) => {
    if (path === `/v1/subscriptions/${native.id}`) return native;
    if (path === `/v1/subscription_schedules/${schedule.id}`) return schedule;
    throw Error(`Unexpected ${path}`);
  });
  await expect(
    scheduleBillingChange(
      f.stripe,
      { ...selected, providerScheduleId: schedule.id },
      saved,
    ),
  ).rejects.toThrow("receipt write unavailable");
  expect(saved).toHaveBeenCalledWith(schedule.id);
  expect(f.requests.filter((r) => r.method === "POST")).toHaveLength(0);
});
