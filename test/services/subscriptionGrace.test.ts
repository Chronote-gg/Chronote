/** @jest-environment node */
import * as renewalRepository from "../../src/repositories/renewalRecoveryRepository";
import { config } from "../../src/services/configService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import {
  renewalRecoverySchema,
  renewalRecoveryKey,
} from "../../src/types/renewalRecovery";
import {
  clearGuildSubscriptionCache,
  resolveGuildSubscription,
  getGuildLimits,
} from "../../src/services/subscriptionService";
import { createManualEntitlementGrant } from "../../src/services/entitlementService";
import { renewalSubscription } from "../fixtures/renewal";
import {
  paidEndsAt,
  sourceSubscription,
  fundedInvoice,
} from "../fixtures/renewalStripe";
import { stripeTransport } from "../fixtures/stripeTransport";
import { getStripeClient } from "../../src/services/stripeClient";
jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: jest.fn(() => null),
}));
const original = {
  mock: config.mock.enabled,
  key: config.stripe.secretKey,
  mode: config.subscription.stripeMode,
  enabled: config.stripe.renewalGraceEnabled,
  force: config.subscription.forceTier,
};
const deadline = paidEndsAt + 3600 + 172800;
beforeEach(() => {
  config.mock.enabled = true;
  config.stripe.secretKey = "sk_test_fixture";
  config.subscription.stripeMode = "test";
  config.stripe.renewalGraceEnabled = true;
  config.subscription.forceTier = "";
  jest.mocked(getStripeClient).mockReturnValue(null);
  resetMockStore();
  clearGuildSubscriptionCache();
  jest.spyOn(Date, "now").mockReturnValue((deadline - 1) * 1000);
});
afterEach(() => {
  config.mock.enabled = original.mock;
  config.stripe.secretKey = original.key;
  config.subscription.stripeMode = original.mode;
  config.stripe.renewalGraceEnabled = original.enabled;
  config.subscription.forceTier = original.force;
  jest.restoreAllMocks();
  clearGuildSubscriptionCache();
});
function seed(
  state: "grace" | "canceling" | "canceled" | "watching" = "grace",
) {
  const pointer = {
    ...renewalSubscription,
    stripeCustomerId: "cus_renewal",
    status: state === "canceled" ? "canceled" : "past_due",
    tier: "basic",
  };
  getMockStore().subscriptions.set(pointer.guildId, pointer);
  const common = {
    guildId: pointer.guildId,
    subscriptionId: pointer.stripeSubscriptionId,
    customerId: "cus_renewal",
    payerId: "222222222222222222",
    mode: "test",
    revision: "r1",
    paid: {
      invoiceId: "in_paid",
      priceId: "price_pro",
      tier: "pro",
      interval: "month",
      periodStart: paidEndsAt - 2592000,
      periodEnd: paidEndsAt,
    },
    scheduledOperationId: null,
    enforcementAccepted: true,
  };
  const record = renewalRecoverySchema.parse(
    state === "watching"
      ? {
          ...common,
          state,
          enforcementAccepted: false,
          nextCheckAt: paidEndsAt,
        }
      : {
          ...common,
          state,
          invoice: {
            id: "in_renewal",
            lineId: "il_plan",
            finalizedAt: paidEndsAt + 3600,
            periodStart: paidEndsAt,
            periodEnd: paidEndsAt + 2592000,
          },
          endsAt: deadline,
          ...(state === "canceled" ? {} : { nextCheckAt: deadline }),
          ...(state === "grace"
            ? {}
            : {
                reason: "payer",
                receipts: {
                  creditNoteId: "cn_owned",
                  refundIds: [],
                  canceled: state === "canceled",
                  collectionRestored: state === "canceled",
                  collectionToRestore: state === "canceled" ? [] : null,
                },
              }),
        },
  );
  const key = renewalRecoveryKey(record);
  getMockStore().renewalRecoveryRecords.set(key, record);
  getMockStore().renewalRecoveryPointers.set(pointer.guildId, {
    key,
    revision: record.revision,
    blocking: state !== "canceled",
  });
  return pointer.guildId;
}
test.each(["grace", "canceling", "canceled"] as const)(
  "keeps prior Pro until the exact deadline in %s and expires a warm cache",
  async (state) => {
    const guildId = seed(state);
    expect(await resolveGuildSubscription(guildId)).toMatchObject({
      tier: "pro",
      stripeTier: "pro",
    });
    jest.mocked(Date.now).mockReturnValue(deadline * 1000);
    expect(await resolveGuildSubscription(guildId)).toMatchObject({
      tier: "free",
      stripeTier: null,
    });
    expect((await getGuildLimits(guildId)).limits.liveVoiceEnabled).toBe(false);
  },
);
test("accepted grace still expires after enforcement is disabled", async () => {
  const guildId = seed();
  config.stripe.renewalGraceEnabled = false;
  expect((await resolveGuildSubscription(guildId)).tier).toBe("pro");
  jest.mocked(Date.now).mockReturnValue(deadline * 1000);
  expect((await resolveGuildSubscription(guildId)).tier).toBe("free");
});
test("independent entitlement grants survive the grace deadline", async () => {
  const guildId = seed();
  await createManualEntitlementGrant({
    guildId,
    tier: "basic",
    createdBy: "admin",
  });
  jest.mocked(Date.now).mockReturnValue(deadline * 1000);
  expect(await resolveGuildSubscription(guildId)).toMatchObject({
    tier: "basic",
    billingSource: "manual_comp",
  });
});
test("a stale active watch cannot invent a paid renewal during provider outage", async () => {
  const guildId = seed("watching");
  const saved = getMockStore().subscriptions.get(guildId);
  if (!saved) throw new Error("Missing subscription");
  saved.status = "active";
  expect((await resolveGuildSubscription(guildId)).tier).toBe("free");
});
test("untracked past-due subscriptions have no unbounded paid access under enforcement", async () => {
  const guildId = seed();
  getMockStore().renewalRecoveryPointers.clear();
  expect((await resolveGuildSubscription(guildId)).tier).toBe("free");
});
test("disabled enforcement leaves unaccepted legacy access unchanged", async () => {
  const guildId = seed("watching");
  config.stripe.renewalGraceEnabled = false;
  expect((await resolveGuildSubscription(guildId)).tier).toBe("basic");
});
test("older canceled courtesy cannot override a replacement subscription", async () => {
  const guildId = seed("canceled");
  const saved = getMockStore().subscriptions.get(guildId);
  if (!saved) throw new Error("Missing subscription");
  saved.stripeSubscriptionId = "sub_new";
  saved.status = "incomplete";
  expect((await resolveGuildSubscription(guildId)).tier).toBe("free");
});

test("the last verified paid period also bounds the cache when renewal evidence is unavailable", async () => {
  const guildId = seed("watching");
  jest.mocked(Date.now).mockReturnValue((paidEndsAt - 1) * 1000);
  expect((await resolveGuildSubscription(guildId)).tier).toBe("pro");
  jest.mocked(Date.now).mockReturnValue(paidEndsAt * 1000);
  expect((await resolveGuildSubscription(guildId)).tier).toBe("free");
});
test("a newly verified paid subscription wins over older canceled courtesy", async () => {
  const guildId = seed("canceled");
  const saved = getMockStore().subscriptions.get(guildId);
  if (!saved) throw new Error("Missing subscription");
  saved.stripeSubscriptionId = "sub_new";
  saved.stripeCustomerId = "cus_renewal";
  saved.status = "active";
  const native = { ...sourceSubscription, id: "sub_new" };
  const invoice = {
    ...fundedInvoice,
    parent: {
      type: "subscription_details",
      quote_details: null,
      subscription_details: { subscription: "sub_new", metadata: {} },
    },
    lines: {
      ...fundedInvoice.lines,
      data: fundedInvoice.lines.data.map((line) => ({
        ...line,
        parent: {
          type: "subscription_item_details",
          invoice_item_details: null,
          subscription_item_details: {
            ...line.parent?.subscription_item_details,
            subscription: "sub_new",
          },
        },
      })),
    },
  };
  const f = stripeTransport((request) => {
    if (request.path === "/v1/subscriptions/sub_new") return native;
    if (request.path === `/v1/invoices/${invoice.id}`) return invoice;
    throw new Error(`Unexpected request ${request.path}`);
  });
  jest.mocked(getStripeClient).mockReturnValue(f.stripe);
  jest.mocked(Date.now).mockReturnValue((paidEndsAt - 1) * 1000);
  expect((await resolveGuildSubscription(guildId)).tier).toBe("basic");
});

test("unavailable renewal evidence cannot erase an independent valid grant", async () => {
  const guildId = seed();
  await createManualEntitlementGrant({
    guildId,
    tier: "basic",
    createdBy: "admin",
  });
  const repository = renewalRepository.getRenewalRecoveryRepository();
  jest
    .spyOn(renewalRepository, "getRenewalRecoveryRepository")
    .mockReturnValue({
      ...repository,
      getCurrent: jest.fn(async () => {
        throw new Error("Renewal storage unavailable");
      }),
    });
  const warning = jest
    .spyOn(console, "warn")
    .mockImplementation(() => undefined);
  expect(await resolveGuildSubscription(guildId)).toMatchObject({
    tier: "basic",
    billingSource: "manual_comp",
  });
  expect(warning).toHaveBeenCalled();
});
