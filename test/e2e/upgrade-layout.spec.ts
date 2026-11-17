import { test, expect } from "@playwright/test";
import { introPlans } from "../../src/frontend/pages/basicIntroFixtures";
import { assertPageCanScroll } from "./scrollAssertions";

for (const viewport of [
  { width: 1366, height: 600 },
  { width: 1280, height: 720 },
  { width: 768, height: 600 },
  { width: 390, height: 844 },
]) {
  for (const interval of ["month", "year"]) {
    test(`signed-out upgrade ${viewport.width}x${viewport.height} ${interval} @visual`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.route("**/trpc/**", async (route) => {
        const paths = decodeURIComponent(
          new URL(route.request().url()).pathname.split("/trpc/")[1],
        ).split(",");
        const results = paths.map((path) => ({
          result: {
            data:
              path === "pricing.plans"
                ? {
                    plans: introPlans,
                    introOffer: { status: "inactive" },
                    annualIntroOffer: { status: "inactive" },
                  }
                : null,
          },
        }));
        await route.fulfill({ json: results });
      });
      await page.goto(
        `/upgrade?serverId=example&source=discord_limit&interval=${interval}`,
      );
      const basic = page.getByTestId("upgrade-plan-basic");
      const price = basic.getByText(
        interval === "year" ? "$100 / yr" : "$10 / mo",
        { exact: true },
      );
      const action = basic.getByRole("button", { name: "Continue with Basic" });
      await expect(price).toBeInViewport({ ratio: 1 });
      await expect(action).toBeInViewport({ ratio: 1 });
      await expect(action).toBeEnabled();
      await expect(page.getByText(/Best value/i)).toHaveCount(0);
      const period = await page
        .getByTestId("upgrade-billing-period")
        .boundingBox();
      expect(period!.height).toBeLessThanOrEqual(48);
      expect(period!.width).toBeLessThanOrEqual(Math.min(viewport.width, 320));
      await assertPageCanScroll(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (process.env.PW_VISUAL === "true") {
        await expect(page).toHaveScreenshot(
          `upgrade-signed-out-${viewport.width}-${viewport.height}-${interval}.png`,
          { animations: "disabled" },
        );
      }
      await page.route("**/auth/discord?**", (route) =>
        route.fulfill({ contentType: "text/html", body: "Sign-in fixture" }),
      );
      await action.click();
      await page.waitForURL("**/auth/discord?**");
      const redirect = new URL(
        new URL(page.url()).searchParams.get("redirect")!,
      );
      expect(redirect.searchParams.get("plan")).toBe("basic");
      expect(redirect.searchParams.get("serverId")).toBe("example");
      expect(redirect.searchParams.get("interval")).toBe(interval);
      expect(redirect.searchParams.get("source")).toBe("discord_limit");
    });
  }
}
