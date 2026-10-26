/** @jest-environment node */
import Stripe from "stripe";
import { scanHistoricalOffers } from "../../src/services/historicalOfferScan";
import { assessHistoricalOfferHistory } from "../../src/services/historicalOfferHistory";
const scope = {
  guildId: "111111111111111111",
  mode: "test" as const,
  accountId: "acct-owned",
  createdBefore: 1000,
};
function fixture() {
  const stripe = new Stripe("sk_test_unused");
  const account = jest
    .spyOn(stripe.accounts, "retrieve")
    .mockResolvedValue({ id: "acct-owned" } as never);
  const balance = jest
    .spyOn(stripe.balance, "retrieve")
    .mockResolvedValue({ livemode: false } as never);
  const list = jest
    .spyOn(stripe.invoices, "list")
    .mockResolvedValue({ data: [], has_more: false } as never);
  const retrieve = jest.spyOn(stripe.invoices, "retrieve");
  const checkouts = jest
    .spyOn(stripe.checkout.sessions, "list")
    .mockResolvedValue({ data: [], has_more: false } as never);
  return { stripe, account, balance, list, retrieve, checkouts };
}
const invoice = (id: string, guildId = scope.guildId) => ({
  id,
  livemode: false,
  created: 500,
  billing_reason: "subscription_create",
  status: "paid",
  parent: {
    subscription_details: {
      metadata: { guild_id: guildId },
      subscription: "sub",
    },
  },
  discounts: [],
  total_discount_amounts: [],
  lines: { has_more: false, data: [] },
});
afterEach(() => jest.restoreAllMocks());
test("verifies native account and mode before listing private history", async () => {
  const f = fixture();
  f.account.mockResolvedValueOnce({ id: "wrong-account" } as never);
  await expect(
    scanHistoricalOffers({ stripe: f.stripe, scope }),
  ).rejects.toThrow();
  expect(f.list).not.toHaveBeenCalled();
});
test("mode mismatch prevents any invoice enumeration", async () => {
  const f = fixture();
  f.balance.mockResolvedValueOnce({ livemode: true } as never);
  await expect(
    scanHistoricalOffers({ stripe: f.stripe, scope }),
  ).rejects.toThrow();
  expect(f.list).not.toHaveBeenCalled();
});
test("all invoice pages are enumerated at fixed cutoff across former payers", async () => {
  const f = fixture();
  f.list
    .mockResolvedValueOnce({
      data: [invoice("in-one")],
      has_more: true,
    } as never)
    .mockResolvedValueOnce({
      data: [invoice("in-two")],
      has_more: false,
    } as never);
  f.retrieve.mockImplementation(async (id) => invoice(id) as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.enumeration).toBe("complete");
  expect(batch.entries.map((e) => e.invoiceId)).toEqual(["in-one", "in-two"]);
  expect(f.list).toHaveBeenNthCalledWith(2, {
    created: { lte: 1000 },
    limit: 100,
    starting_after: "in-one",
  });
});
test("exhausting a page budget cannot establish complete coverage", async () => {
  const f = fixture();
  f.list.mockResolvedValue({
    data: [invoice("in-one")],
    has_more: true,
  } as never);
  f.retrieve.mockResolvedValue(invoice("in-one") as never);
  expect(
    (await scanHistoricalOffers({ stripe: f.stripe, scope, maxPages: 1 }))
      .enumeration,
  ).toBe("incomplete");
});
test("native ordinary history remains unavailable until writer/catch-up verification", async () => {
  const f = fixture();
  f.list.mockResolvedValue({
    data: [invoice("in-one")],
    has_more: false,
  } as never);
  f.retrieve.mockResolvedValue(invoice("in-one") as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.catchUp).toBe("pending");
  expect(assessHistoricalOfferHistory(batch).monthly.kind).toBe("unresolved");
});
test("unknown historical server ownership is retained as unresolved", async () => {
  const f = fixture();
  const raw = { ...invoice("unknown"), parent: null };
  f.list.mockResolvedValue({ data: [raw], has_more: false } as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.entries[0].evidence).toMatchObject({
    kind: "unresolved",
    offerId: null,
    reason: "missing_snapshot",
  });
});
test("other servers are excluded while malformed/repeated provider pages reject", async () => {
  const f = fixture();
  f.list.mockResolvedValueOnce({
    data: [invoice("in-other", "222222222222222222")],
    has_more: false,
  } as never);
  expect(
    (await scanHistoricalOffers({ stripe: f.stripe, scope })).entries,
  ).toEqual([]);
  expect(f.retrieve).not.toHaveBeenCalled();
  f.list.mockResolvedValue({
    data: [invoice("in-one")],
    has_more: true,
  } as never);
  f.retrieve.mockResolvedValue(invoice("in-one") as never);
  await expect(
    scanHistoricalOffers({ stripe: f.stripe, scope, maxPages: 2 }),
  ).rejects.toThrow();
});

test("malformed historical owner is unresolved, never treated as another server", async () => {
  const f = fixture();
  f.list.mockResolvedValueOnce({
    data: [invoice("malformed", "not-a-server")],
    has_more: false,
  } as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.entries[0].evidence).toMatchObject({
    kind: "unresolved",
    offerId: null,
  });
});
test("retrieved original must have the requested invoice identity", async () => {
  const f = fixture();
  f.list.mockResolvedValueOnce({
    data: [invoice("requested")],
    has_more: false,
  } as never);
  f.retrieve.mockResolvedValueOnce(invoice("different") as never);
  await expect(
    scanHistoricalOffers({ stripe: f.stripe, scope }),
  ).rejects.toThrow("identity mismatch");
});

test("an older open Checkout without an invoice remains a pending candidate", async () => {
  const f = fixture();
  f.checkouts.mockResolvedValueOnce({
    data: [
      {
        id: "cs-old",
        livemode: false,
        created: 500,
        status: "open",
        metadata: { guild_id: scope.guildId, intro_offer_id: "basic_intro_v1" },
        subscription: null,
        invoice: null,
        payment_status: "unpaid",
      },
    ],
    has_more: false,
  } as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.checkoutEvidence).toEqual([
    { kind: "unresolved", sessionId: "cs-old", offerId: "basic_intro_v1" },
  ]);
  expect(
    assessHistoricalOfferHistory({ ...batch, catchUp: "complete" }).monthly
      .kind,
  ).toBe("unresolved");
});
test("completed Checkout outside invoice inventory cannot be silently missed", async () => {
  const f = fixture();
  f.checkouts.mockResolvedValueOnce({
    data: [
      {
        id: "cs-late",
        livemode: false,
        created: 500,
        status: "complete",
        metadata: {
          guild_id: scope.guildId,
          intro_offer_id: "basic_annual_intro_v1",
        },
        subscription: "sub-late",
        invoice: "in-after-cutoff",
        payment_status: "paid",
      },
    ],
    has_more: false,
  } as never);
  expect(
    (await scanHistoricalOffers({ stripe: f.stripe, scope })).checkoutEvidence,
  ).toEqual([
    {
      kind: "unresolved",
      sessionId: "cs-late",
      offerId: "basic_annual_intro_v1",
    },
  ]);
});
test("an expired checkout without a subscription or invoice has no future payment to catch up", async () => {
  const f = fixture();
  f.checkouts.mockResolvedValueOnce({
    data: [
      {
        id: "cs-expired",
        livemode: false,
        created: 500,
        status: "expired",
        metadata: { guild_id: scope.guildId },
        subscription: null,
        invoice: null,
      },
    ],
    has_more: false,
  } as never);
  expect(
    (await scanHistoricalOffers({ stripe: f.stripe, scope })).checkoutEvidence,
  ).toEqual([]);
});

test("unknown Checkout owner cannot attribute a claimed offer to just one cadence", async () => {
  const f = fixture();
  f.checkouts.mockResolvedValueOnce({
    data: [
      {
        id: "cs-unknown",
        livemode: false,
        created: 500,
        status: "open",
        metadata: { intro_offer_id: "basic_intro_v1" },
      },
    ],
    has_more: false,
  } as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.checkoutEvidence?.[0].offerId).toBeNull();
  const result = assessHistoricalOfferHistory({
    ...batch,
    catchUp: "complete",
  });
  expect(result.monthly.kind).toBe("unresolved");
  expect(result.annual.kind).toBe("unresolved");
});
test("a discounted renewal without a proven first offer use stays unresolved", async () => {
  const f = fixture();
  const cycle = {
    ...invoice("in-cycle"),
    billing_reason: "subscription_cycle",
    parent: {
      subscription_details: {
        subscription: "sub",
        metadata: { guild_id: scope.guildId, intro_offer_id: "basic_intro_v1" },
      },
    },
  };
  f.list.mockResolvedValueOnce({ data: [cycle], has_more: false } as never);
  f.retrieve.mockResolvedValueOnce(cycle as never);
  const batch = await scanHistoricalOffers({ stripe: f.stripe, scope });
  expect(batch.entries[0].evidence).toMatchObject({
    kind: "unresolved",
    offerId: "basic_intro_v1",
  });
});
test("Checkout page limits and repeated session identities cannot establish closure", async () => {
  const f = fixture();
  f.checkouts.mockResolvedValue({
    data: [
      {
        id: "cs-one",
        livemode: false,
        created: 500,
        status: "expired",
        subscription: null,
        invoice: null,
      },
    ],
    has_more: true,
  } as never);
  expect(
    (await scanHistoricalOffers({ stripe: f.stripe, scope, maxPages: 1 }))
      .enumeration,
  ).toBe("incomplete");
  await expect(
    scanHistoricalOffers({ stripe: f.stripe, scope, maxPages: 2 }),
  ).rejects.toThrow("identity mismatch");
});

test.each(["invoice", "checkout"] as const)(
  "malformed %s pagination cannot claim complete coverage",
  async (kind) => {
    for (const page of [
      { data: [] },
      { data: [], has_more: null },
      { data: null, has_more: false },
    ]) {
      const f = fixture();
      (kind === "invoice" ? f.list : f.checkouts).mockResolvedValueOnce(
        page as never,
      );
      await expect(
        scanHistoricalOffers({ stripe: f.stripe, scope }),
      ).rejects.toThrow();
      jest.restoreAllMocks();
    }
  },
);
