import type { Page } from "@playwright/test";

// Keep provider state out of UI purchase tests; the real mock runtime forces Pro.
export async function useFreeBilling(page: Page) {
  await page.route("**/trpc/**", async (route) => {
    const paths = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/trpc/")[1],
    ).split(",");
    if (!paths.includes("billing.me")) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const entries = Array.isArray(body) ? body : [body];
    const next = entries.map((entry, index) =>
      paths[index] === "billing.me"
        ? {
            result: {
              data: {
                tier: "free",
                billingSource: "free",
                status: "free",
                billingEnabled: true,
                hasStripeBilling: false,
                canManageBillingPortal: false,
                usage: null,
              },
            },
          }
        : entry,
    );
    await route.fulfill({
      response,
      json: Array.isArray(body) ? next : next[0],
    });
  });
}
