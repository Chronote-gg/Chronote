/** @jest-environment node */
import {
  renewalGraceDeadline,
  renewalRecoverySchema,
  assertRenewalRecoveryTransition,
} from "../../src/types/renewalRecovery";

const base = {
  guildId: "999999999999999990",
  subscriptionId: "sub_owned",
  customerId: "cus_owned",
  payerId: "211750261922725888",
  mode: "test",
  revision: "r1",
  paid: {
    invoiceId: "in_paid",
    priceId: "price_pro",
    tier: "pro",
    interval: "year",
    periodStart: 1,
    periodEnd: 1000000,
  },
  scheduledOperationId: null,
  enforcementAccepted: false,
  state: "watching",
  nextCheckAt: 1000000,
};

test("anchors the fixed two-day grace to provider finalization", () => {
  expect(renewalGraceDeadline(1000000)).toBe(1172800);
});

test("rejects invalid paid periods and incomplete grace evidence", () => {
  expect(
    renewalRecoverySchema.safeParse({
      ...base,
      paid: { ...base.paid, periodEnd: 0 },
    }).success,
  ).toBe(false);
  expect(
    renewalRecoverySchema.safeParse({ ...base, state: "grace" }).success,
  ).toBe(false);
});

test("cannot change the paid source or restart an adopted deadline", () => {
  const previous = renewalRecoverySchema.parse(base);
  const changed = renewalRecoverySchema.parse({
    ...base,
    revision: "r2",
    paid: { ...base.paid, tier: "basic" },
  });
  expect(() => assertRenewalRecoveryTransition(changed, previous)).toThrow();
  const grace = renewalRecoverySchema.parse({
    ...base,
    state: "grace",
    enforcementAccepted: true,
    invoice: {
      id: "in_renew",
      lineId: "il_plan",
      finalizedAt: 1000000,
      periodStart: 1000000,
      periodEnd: 2000000,
    },
    endsAt: 1172800,
  });
  expect(() =>
    assertRenewalRecoveryTransition(
      renewalRecoverySchema.parse({
        ...grace,
        revision: "r2",
        endsAt: 1172801,
      }),
      grace,
    ),
  ).toThrow();
});

test("allows accepted recovery to retain its deadline during cancellation", () => {
  const grace = renewalRecoverySchema.parse({
    ...base,
    state: "grace",
    enforcementAccepted: true,
    invoice: {
      id: "in_renew",
      lineId: "il_plan",
      finalizedAt: 1000000,
      periodStart: 1000000,
      periodEnd: 2000000,
    },
    endsAt: 1172800,
  });
  const next = renewalRecoverySchema.parse({
    ...grace,
    state: "canceling",
    revision: "r2",
    reason: "payer",
    receipts: { creditNoteId: null, refundIds: [], canceled: false },
  });
  expect(() => assertRenewalRecoveryTransition(next, grace)).not.toThrow();
});

test("rejects terminal cancellation until native collection restoration is proved", () => {
  const { nextCheckAt, ...fields } = base;
  void nextCheckAt;
  expect(
    renewalRecoverySchema.safeParse({
      ...fields,
      state: "canceled",
      reason: "payer",
      invoice: {
        id: "in_renew",
        lineId: "il_plan",
        finalizedAt: 1000000,
        periodStart: 1000000,
        periodEnd: 2000000,
      },
      endsAt: 1172800,
      receipts: {
        creditNoteId: "cn_owned",
        refundIds: [],
        canceled: true,
        collectionRestored: false,
      },
    }).success,
  ).toBe(false);
});
