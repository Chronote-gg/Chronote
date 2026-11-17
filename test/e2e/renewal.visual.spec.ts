import { test, expect } from "./fixtures";
import { useIntroBilling } from "./billingMocks";
import { annualSubscriber } from "../../src/frontend/pages/basicIntroFixtures";
import { createRenewalFixture } from "../../src/frontend/pages/renewalFixtures";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import type { RenewalView } from "../../src/types/renewal";
import type { Page } from "@playwright/test";

async function openBilling(page: Page) {
  const billingResponse = page.waitForResponse((response) => {
    const paths = new URL(response.url()).pathname.split("/trpc/")[1];
    return Boolean(
      paths && decodeURIComponent(paths).split(",").includes("billing.me"),
    );
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await (await billingResponse).finished();
}

const runVisual = process.env.PW_VISUAL === "true";
const views = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
];
for (const viewport of views) {
  for (const state of ["off"] as const) {
    test(`renewal ${state} at ${viewport.name} @visual`, async ({ page }) => {
      test.skip(!runVisual, "Visual regression disabled");
      await page.setViewportSize(viewport);
      await applyVisualDefaults(page);
      const renewal = createRenewalFixture({
        details: annualSubscriber,
        cancellationAt: annualSubscriber.renewalAt,
      });
      await useIntroBilling(page, {
        details: annualSubscriber,
        cancellationAt: annualSubscriber.renewalAt,
        renewal,
      });
      await openBilling(page);
      await expect(page.getByTestId("billing-current-plan")).toBeVisible();
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
  await openBilling(page);
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

test("renewal waits for slow billing data before checking rendering", async ({
  page,
}) => {
  await useIntroBilling(page, { details: annualSubscriber });
  await page.route("**/trpc/**", async (route) => {
    if (route.request().url().includes("billing.me"))
      await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fallback();
  });
  await openBilling(page);
  await expect(page.getByTestId("billing-current-plan")).toBeVisible();
});
