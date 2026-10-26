import { RENEWAL_QUOTE_TTL_MS } from "../../src/utils/renewalConstants";
import { test, expect } from "./fixtures";
import { useIntroBilling, type IntroBillingOptions } from "./billingMocks";
import { annualSubscriber } from "../../src/frontend/pages/basicIntroFixtures";
import { createRenewalFixture } from "../../src/frontend/pages/renewalFixtures";
import { mockGuilds } from "./mockData";

const ready = () =>
  createRenewalFixture({
    details: annualSubscriber,
    cancellationAt: annualSubscriber.renewalAt,
  });
const options = (): IntroBillingOptions => ({
  details: { ...annualSubscriber, cancelAtPeriodEnd: true },
  cancellationAt: annualSubscriber.renewalAt,
  renewal: ready(),
});
test("renewal off has one clear action and separate payment history", async ({
  page,
}) => {
  await useIntroBilling(page, options());
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const current = page.getByTestId("billing-current-plan");
  await expect(current.getByText("Renewal off", { exact: true })).toBeVisible();
  await expect(current.getByText("ACTIVE", { exact: true })).toHaveCount(0);
  await expect(current).toContainText("Your Basic plan ends October 12, 2027.");
  await expect(current).toContainText("$100/year before tax");
  await expect(current).not.toContainText("$64.20 paid");
  const history = page.getByTestId("billing-payment-history");
  await history.getByRole("button", { name: "Payment history" }).click();
  await expect(history).toContainText("$64.20");
  await expect(
    history.getByRole("button", { name: "View invoices and receipts" }),
  ).toBeEnabled();
});
test("renewal confirmation and status checks reuse consent without checkout", async ({
  page,
}) => {
  const fixture = options();
  const initial = fixture.renewal;
  if (initial?.state.kind !== "off" || initial.state.action.kind !== "ready")
    throw Error("Missing synthetic ready quote");
  const terms = initial.state.action.terms;
  await useIntroBilling(page, fixture);
  const calls: unknown[] = [];
  await page.route("**/trpc/billing.reactivateRenewal*", async (route) => {
    calls.push(route.request().postDataJSON());
    fixture.renewal =
      calls.length === 1
        ? {
            state: {
              kind: "processing",
              operationId: "00000000-0000-4000-8000-000000000001",
              endsAt: terms.renewsAt,
            },
            canManageBilling: true,
            lifecycleAnalyticsEnabled: false,
          }
        : {
            state: { kind: "on", terms },
            canManageBilling: true,
            lifecycleAnalyticsEnabled: false,
          };
    return route.fulfill({
      status: 200,
      json: [
        {
          result: {
            data:
              calls.length === 1
                ? {
                    kind: "processing",
                    operationId: "00000000-0000-4000-8000-000000000001",
                  }
                : { kind: "confirmed", terms },
          },
        },
      ],
    });
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await page.getByRole("button", { name: "Turn renewal back on" }).click();
  await expect(
    page.getByText("Checking renewal", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(page.getByTestId("billing-current-plan")).toContainText(
    "Renews October 12, 2027",
  );
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({
    "0": {
      request: { kind: "confirm", quoteToken: "synthetic-renewal-consent" },
    },
  });
  expect(calls[1]).toMatchObject({
    "0": {
      request: {
        kind: "recover",
        operationId: "00000000-0000-4000-8000-000000000001",
      },
    },
  });
});
test("another manager cannot open the payer's portal or submit renewal consent", async ({
  page,
}) => {
  const fixture = options();
  fixture.renewal = createRenewalFixture({
    details: annualSubscriber,
    cancellationAt: annualSubscriber.renewalAt,
    canManageBilling: false,
  });
  await useIntroBilling(page, fixture);
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await expect(page.getByText(/original payer/).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Turn renewal back on" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage billing", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "View invoices and receipts" }),
  ).toHaveCount(0);
});
test("expired consent refreshes terms and requires another deliberate click", async ({
  page,
}) => {
  const fixture = options();
  const expired = fixture.renewal;
  if (expired?.state.kind !== "off" || expired.state.action.kind !== "ready")
    throw Error("Expected ready quote");
  expired.state.action.expiresAt = Date.now() - 1;
  await useIntroBilling(page, fixture);
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await expect(
    page.getByRole("button", { name: "Turn renewal back on" }),
  ).toBeEnabled();
  const terms = { ...expired.state.action.terms, unitAmount: 12000 };
  fixture.renewal = {
    ...expired,
    state: {
      ...expired.state,
      action: {
        ...expired.state.action,
        quoteToken: "refreshed-consent",
        expiresAt: Date.now() + RENEWAL_QUOTE_TTL_MS,
        terms,
      },
    },
  };
  const calls: unknown[] = [];
  await page.route("**/trpc/billing.reactivateRenewal*", async (route) => {
    calls.push(route.request().postDataJSON());
    fixture.renewal = {
      state: {
        kind: "processing",
        operationId: "00000000-0000-4000-8000-000000000001",
        endsAt: terms.renewsAt,
      },
      canManageBilling: true,
      lifecycleAnalyticsEnabled: false,
    };
    return route.fulfill({
      status: 200,
      json: [
        {
          result: {
            data: {
              kind: "processing",
              operationId: "00000000-0000-4000-8000-000000000001",
            },
          },
        },
      ],
    });
  });
  await page.getByRole("button", { name: "Turn renewal back on" }).click();
  await expect(page.getByTestId("billing-current-plan")).toContainText(
    "$120/year",
  );
  expect(calls).toHaveLength(0);
  await page.getByRole("button", { name: "Turn renewal back on" }).click();
  await expect.poll(() => calls.length).toBe(1);
  expect(calls[0]).toMatchObject({
    "0": { request: { kind: "confirm", quoteToken: "refreshed-consent" } },
  });
});
for (const stripeStatus of ["past_due", "unpaid"] as const) {
  for (const payer of [true, false]) {
    test(`${stripeStatus} without cancellation retains payment attention for ${payer ? "payer" : "another manager"}`, async ({
      page,
    }) => {
      await useIntroBilling(page, {
        details: annualSubscriber,
        stripeStatus,
        renewal: {
          state: { kind: "payment_problem" },
          canManageBilling: payer,
          lifecycleAnalyticsEnabled: false,
        },
      });
      await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
      const current = page.getByTestId("billing-current-plan");
      await expect(current).toContainText("Basic");
      await expect(current).toContainText("Payment needs attention");
      await expect(current).not.toContainText(
        "Renewal details aren't available",
      );
      await expect(
        current.getByRole("button", { name: "Turn renewal back on" }),
      ).toHaveCount(0);
      if (payer)
        await expect(
          current.getByRole("button", { name: "Manage billing", exact: true }),
        ).toBeEnabled();
      else {
        await expect(current).toContainText("original payer");
        await expect(
          current.getByRole("button", { name: "Manage billing", exact: true }),
        ).toHaveCount(0);
      }
    });
  }
}
