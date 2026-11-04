import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

export async function assertPageCanScroll(
  page: Page,
  target?: Locator,
): Promise<void> {
  if (target) {
    const metrics = await target.evaluate((element) => {
      element.scrollTop = 0;
      const before = element.scrollTop;
      element.scrollTop = 100;
      return {
        height: element.scrollHeight,
        client: element.clientHeight,
        before,
        after: element.scrollTop,
      };
    });
    expect(metrics.height).toBeGreaterThan(metrics.client);
    expect(metrics.after).toBeGreaterThan(metrics.before);
    await target.evaluate((element) => {
      element.scrollTop = 0;
    });
    return;
  }
  const scroll = await page.evaluate(() => {
    const elements = [
      document.scrollingElement,
      ...document.querySelectorAll<HTMLElement>("*"),
    ];
    const element = elements.find(
      (candidate) =>
        candidate &&
        candidate.scrollHeight > candidate.clientHeight + 10 &&
        (candidate === document.scrollingElement ||
          ["auto", "scroll"].includes(getComputedStyle(candidate).overflowY)),
    );
    if (!element) return null;
    element.scrollTop = 0;
    const before = element.scrollTop;
    element.scrollTop = 100;
    const result = {
      height: element.scrollHeight,
      client: element.clientHeight,
      before,
      after: element.scrollTop,
    };
    element.scrollTop = 0;
    return result;
  });
  expect(scroll).not.toBeNull();
  expect(scroll!.height).toBeGreaterThan(scroll!.client);
  expect(scroll!.after).toBeGreaterThan(scroll!.before);
}
