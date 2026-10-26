/** @jest-environment node */
import { historicalMonthlyInvoiceFixture } from "../fixtures/historicalOfferInvoice";
import Stripe from "stripe";
import { ECSClient } from "@aws-sdk/client-ecs";
import { importHistoricalOffers } from "../../src/services/historicalOfferImportService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { historyWriterBoundaryKey } from "../../src/types/historyWriterBoundary";
import { historyWriterBoundaryFixture } from "../fixtures/historyWriterBoundary";
const scope = {
  guildId: "111111111111111111",
  mode: "test" as const,
  accountId: "acct-owned",
  createdBefore: 1000,
};
function fixture() {
  const stripe = new Stripe("sk_test_unused");
  jest
    .spyOn(stripe.accounts, "retrieve")
    .mockResolvedValue({ id: scope.accountId } as never);
  jest
    .spyOn(stripe.balance, "retrieve")
    .mockResolvedValue({ livemode: false } as never);
  jest
    .spyOn(stripe.invoices, "list")
    .mockResolvedValue({ data: [], has_more: false } as never);
  jest
    .spyOn(stripe.checkout.sessions, "list")
    .mockResolvedValue({ data: [], has_more: false } as never);
  const ecs = new ECSClient({ region: "us-east-1" });
  const b = historyWriterBoundaryFixture();
  const d = b.deployment;
  const service = {
    serviceArn: d.serviceArn,
    serviceName: "api",
    clusterArn: d.clusterArn,
    status: "ACTIVE",
    taskDefinition: d.taskDefinitionArn,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deployments: [
      {
        status: "PRIMARY",
        taskDefinition: d.taskDefinitionArn,
        rolloutState: "COMPLETED",
      },
    ],
  };
  jest
    .spyOn(ecs, "send")
    .mockResolvedValueOnce({ services: [service] } as never)
    .mockResolvedValueOnce({ taskArns: d.taskArns } as never)
    .mockResolvedValueOnce({
      tasks: d.taskArns.map((taskArn) => ({
        taskArn,
        clusterArn: d.clusterArn,
        lastStatus: "RUNNING",
        desiredStatus: "RUNNING",
        taskDefinitionArn: d.taskDefinitionArn,
        containers: [
          { name: "api", imageDigest: d.imageDigest, lastStatus: "RUNNING" },
        ],
      })),
    } as never)
    .mockResolvedValueOnce({ services: [service] } as never);
  return { stripe, ecs, b };
}
beforeEach(() => {
  resetMockStore();
  getMockStore().subscriptions.delete(scope.guildId);
});
afterEach(() => jest.restoreAllMocks());
test("default dry-run does not write history or usage", async () => {
  const f = fixture();
  const result = await importHistoricalOffers({
    stripe: f.stripe,
    ecs: f.ecs,
    scope,
  });
  expect(result.scope).toEqual(scope);
  expect(result.runId).toBeTruthy();
  expect(result.unresolved).toEqual({ invoices: [], checkouts: [] });
  expect(
    result.outcomes.every(
      (o) => o.state === "unresolved" && o.write === "dry_run",
    ),
  ).toBe(true);
  expect(getMockStore().historicalOfferImports.size).toBe(0);
  expect(getMockStore().offerUsages.size).toBe(0);
});
test("verified deployment and complete native inventories close unused coverage without fabricated usage", async () => {
  const f = fixture();
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(scope.accountId, scope.mode),
    f.b,
  );
  const result = await importHistoricalOffers({
    stripe: f.stripe,
    ecs: f.ecs,
    scope,
    apply: true,
  });
  expect(
    result.outcomes.every((o) => o.state === "unused" && o.write === "applied"),
  ).toBe(true);
  expect(getMockStore().historicalOfferImports.size).toBe(2);
  expect(getMockStore().offerUsages.size).toBe(0);
});
test("an older payable Checkout prevents unused closure even with a verified deployment", async () => {
  const f = fixture();
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(scope.accountId, scope.mode),
    f.b,
  );
  jest.mocked(f.stripe.checkout.sessions.list).mockResolvedValue({
    data: [
      {
        id: "old",
        created: 500,
        livemode: false,
        status: "open",
        metadata: {
          guild_id: scope.guildId,
          intro_offer_id: "basic_intro_v1",
        },
        invoice: null,
        subscription: null,
      },
    ],
    has_more: false,
  } as never);
  const result = await importHistoricalOffers({
    stripe: f.stripe,
    ecs: f.ecs,
    scope,
    apply: true,
  });
  expect(result.outcomes.every((o) => o.state === "unresolved")).toBe(true);
  expect(result.unresolvedCheckouts).toBe(1);
});

test.each(["discounted", "regular"])(
  "monthly paid original with a %s renewal preserves annual eligibility",
  async (kind) => {
    const f = fixture();
    const original = historicalMonthlyInvoiceFixture();
    const cycle = structuredClone(original.invoice);
    cycle.id = "in-cycle";
    cycle.created = 700;
    cycle.billing_reason = "subscription_cycle";
    cycle.status_transitions.paid_at = 701;
    cycle.lines.data[0].invoice = cycle.id;
    cycle.lines.data[0].period = { start: 700, end: 900 };
    if (kind === "regular") {
      cycle.discounts = [];
      cycle.total_discount_amounts = [];
      cycle.lines.data[0].discount_amounts = [];
      cycle.amount_paid = 1000;
    }
    getMockStore().historyWriterBoundaries.set(
      historyWriterBoundaryKey(scope.accountId, scope.mode),
      f.b,
    );
    jest.mocked(f.stripe.invoices.list).mockResolvedValue({
      data: [cycle, original.invoice],
      has_more: false,
    } as never);
    jest
      .spyOn(f.stripe.invoices, "retrieve")
      .mockImplementation(
        async (id) => (id === cycle.id ? cycle : original.invoice) as never,
      );
    jest
      .spyOn(f.stripe.prices, "retrieve")
      .mockResolvedValue(original.price as never);
    const result = await importHistoricalOffers({
      stripe: f.stripe,
      ecs: f.ecs,
      scope,
      apply: true,
    });
    expect(result.outcomes).toMatchObject([
      { offerId: "basic_intro_v1", state: "used", write: "applied" },
      { offerId: "basic_annual_intro_v1", state: "unused", write: "applied" },
    ]);
    expect(result.unresolvedInvoices).toBe(0);
    expect(result.assessedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "settled",
          invoiceId: "in-first",
          originalOperationId: "original",
          subscriptionId: "sub",
        }),
        expect.objectContaining({
          kind: "covered_cycle",
          invoiceId: "in-cycle",
          originalInvoiceId: "in-first",
        }),
      ]),
    );
    expect(result.outcomes[1].coverage).toMatchObject({
      boundaryRevision: f.b.revision,
      proposedRevision: expect.any(String),
    });
  },
);
test("a paid cycle after an unpaid void cannot establish unused closure", async () => {
  const f = fixture();
  const original = historicalMonthlyInvoiceFixture();
  const cycle = structuredClone(original.invoice);
  cycle.id = "in-cycle";
  cycle.created = 700;
  cycle.billing_reason = "subscription_cycle";
  cycle.status_transitions.paid_at = 701;
  cycle.lines.data[0].invoice = cycle.id;
  Object.assign(original.invoice, {
    status: "void",
    amount_paid: 0,
    status_transitions: { paid_at: null, voided_at: 501 },
  });
  getMockStore().historyWriterBoundaries.set(
    historyWriterBoundaryKey(scope.accountId, scope.mode),
    f.b,
  );
  jest.mocked(f.stripe.invoices.list).mockResolvedValue({
    data: [cycle, original.invoice],
    has_more: false,
  } as never);
  jest
    .spyOn(f.stripe.invoices, "retrieve")
    .mockImplementation(
      async (id) => (id === cycle.id ? cycle : original.invoice) as never,
    );
  jest
    .spyOn(f.stripe.prices, "retrieve")
    .mockResolvedValue(original.price as never);
  jest.spyOn(f.stripe.subscriptions, "retrieve").mockResolvedValue({
    id: "sub",
    customer: "cus",
    livemode: false,
    status: "incomplete_expired",
  } as never);
  const result = await importHistoricalOffers({
    stripe: f.stripe,
    ecs: f.ecs,
    scope,
  });
  expect(
    result.outcomes.every((outcome) => outcome.state === "unresolved"),
  ).toBe(true);
});
