import { test, expect } from "./fixtures";
import { useIntroBilling, useFreeBilling } from "./billingMocks";
import { annualSubscriber } from "../../src/frontend/pages/basicIntroFixtures";
import { createRenewalFixture } from "../../src/frontend/pages/renewalFixtures";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import type { RenewalView } from "../../src/types/renewal";
const runVisual = process.env.PW_VISUAL === "true";
const views = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "intermediate", width: 768, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
for (const viewport of views) {
  for (const state of [
    "off",
    "on",
    "processing",
    "failure",
    "history-open",
    "terminal",
    "payment-attention",
  ] as const) {
    test(`renewal ${state} at ${viewport.name} @visual`, async ({ page }) => {
      test.skip(!runVisual, "Visual regression disabled");
      await page.setViewportSize(viewport);
      await applyVisualDefaults(page);
      if (state === "terminal")
        await useFreeBilling(page, { terminalStatus: "canceled" });
      else {
        const renewal = createRenewalFixture({
          details: annualSubscriber,
          cancellationAt: state === "on" ? null : annualSubscriber.renewalAt,
        });
        if (state === "processing")
          renewal.state = {
            kind: "processing",
            operationId: "00000000-0000-4000-8000-000000000001",
            endsAt: annualSubscriber.renewalAt!,
          };
        if (state === "payment-attention")
          renewal.state = { kind: "payment_problem" };
        if (state === "failure")
          renewal.state = {
            kind: "unavailable",
            knownEndsAt: annualSubscriber.renewalAt!,
          };
        await useIntroBilling(page, {
          details: annualSubscriber,
          cancellationAt: state === "on" ? null : annualSubscriber.renewalAt,
          renewal,
        });
      }
      await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
      await expect(page.getByTestId("billing-current-plan")).toBeVisible();
      if (state === "history-open") {
        await page
          .getByRole("button", { name: "Payment history", exact: true })
          .click();
        await expect(page.getByText(/\$64.20 paid/)).toBeVisible();
      }
      await waitForVisualReady(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(page).toHaveScreenshot(
        `renewal-${state}-${viewport.name}.png`,
        { fullPage: true, maxDiffPixels: 200 },
      );
    });
  }
}
test("short billing page scrolls to its history and comparison actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 480 });
  const renewal: RenewalView = createRenewalFixture({
    details: annualSubscriber,
    cancellationAt: annualSubscriber.renewalAt,
  });
  await useIntroBilling(page, {
    details: annualSubscriber,
    cancellationAt: annualSubscriber.renewalAt,
    renewal,
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await expect(page.getByTestId("renewal-off")).toBeVisible();
  const scrolling = await page
    .getByTestId("billing-current-plan")
    .evaluate((el) => {
      let parent: Element | null = el.parentElement;
      while (
        parent &&
        !(
          parent.scrollHeight > parent.clientHeight &&
          /auto|scroll/.test(getComputedStyle(parent).overflowY)
        )
      )
        parent = parent.parentElement;
      const container = parent ?? document.scrollingElement!;
      const before = container.scrollTop;
      container.scrollTop = container.scrollHeight;
      return {
        height: container.scrollHeight,
        client: container.clientHeight,
        before,
        after: container.scrollTop,
      };
    });
  expect(scrolling.height).toBeGreaterThan(scrolling.client);
  expect(scrolling.after).toBeGreaterThan(scrolling.before);
  await page
    .getByRole("button", { name: "Payment history", exact: true })
    .click();
  await expect(page.getByText(/\$64.20 paid/)).toBeVisible();
  await page
    .getByRole("button", { name: "View invoices and receipts" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "View invoices and receipts" }),
  ).toBeInViewport();
});
