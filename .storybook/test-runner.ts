import assert from "node:assert/strict";
import type { TestRunnerConfig } from "@storybook/test-runner";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotsDir = resolve(rootDir, "test", "storybook", "screenshots");

const screenshotViewport = (id: string) =>
  id.endsWith("-mobile")
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
    await page.waitForTimeout(150);
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
    await mkdir(screenshotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotsDir, `${context.id}.png`),
      fullPage: !context.id.startsWith("settings-notesdestination--"),
    });
  },
};

export default config;
