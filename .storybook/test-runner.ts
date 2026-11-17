import assert from "node:assert/strict";
import type { TestRunnerConfig } from "@storybook/test-runner";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotsDir = resolve(rootDir, "test", "storybook", "screenshots");

const screenshotViewport = (id: string) =>
  id.endsWith("-short")
    ? { width: 1366, height: 600 }
    : id.endsWith("-mobile")
      ? { width: 390, height: 844 }
      : id.endsWith("-tablet")
        ? { width: 768, height: 900 }
        : { width: 1280, height: 720 };
const config: TestRunnerConfig = {
  async preVisit(page, context) {
    await page.setViewportSize(screenshotViewport(context.id));
  },
  async postVisit(page, context) {
    await page.setViewportSize(screenshotViewport(context.id));
    await page.waitForLoadState("domcontentloaded");
    if (context.id.startsWith("pages-upgradeplans--signed-out-upgrade-")) {
      await page.evaluate(() => window.scrollTo(0, 0));
      const action = page
        .getByTestId("upgrade-plan-basic")
        .getByRole("button", { name: "Continue with Basic" });
      await action.waitFor({ state: "visible", timeout: 5000 });
      const box = await action.boundingBox();
      assert.ok(
        await action.isEnabled(),
        "The plan action must allow Discord sign-in",
      );
      assert.ok(
        box && box.y >= 0 && box.y + box.height <= page.viewportSize()!.height,
        "The initial viewport must show the Basic action",
      );
    }
    if (
      [
        "meetings-unified--mobile",
        "meetings-unified--tablet",
        "meetings-unified--long-sources",
      ].includes(context.id)
    ) {
      const content = page.getByTestId("meeting-browse-scroll");
      await page.getByTestId("library-meeting-row").first().waitFor();
      const metrics = await content.evaluate((element) => {
        element.scrollTop = 100;
        const result = {
          height: element.scrollHeight,
          client: element.clientHeight,
          top: element.scrollTop,
        };
        element.scrollTop = 0;
        return result;
      });
      assert.ok(
        metrics.height > metrics.client && metrics.top > 0,
        "The production Meetings content must scroll",
      );
    }
    if (
      [
        "pages-upgradeplans--billing-plan-change-mobile",
        "pages-upgradeplans--renewal-grace-scheduled-mobile",
      ].includes(context.id)
    ) {
      const dimensions = await page.evaluate(() => ({
        height: document.scrollingElement?.scrollHeight ?? 0,
        viewport: document.scrollingElement?.clientHeight ?? 0,
      }));
      assert.ok(
        dimensions.height > dimensions.viewport,
        "The page must have a vertical scroll range",
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.evaluate(() => window.scrollTo(0, 200));
      assert.ok(
        (await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)) >
          0,
        "The page scroll position must change",
      );
    }
    if (process.env.STORYBOOK_SCREENSHOTS !== "true") return;
    await page.waitForTimeout(150);
    await mkdir(screenshotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotsDir, `${context.id}.png`),
      fullPage:
        !context.id.startsWith("settings-notesdestination--") &&
        !context.id.startsWith("pages-upgradeplans--signed-out-upgrade-"),
    });
  },
};

export default config;
