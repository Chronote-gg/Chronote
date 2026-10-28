import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";

type CaptureAskScreenshot = (
  page: Page,
  name: string,
  mode: "viewport" | "full",
) => Promise<void>;

export function registerAskVisualTests(
  expectVisualScreenshot: CaptureAskScreenshot,
): void {
  test("ask page @visual", async ({ serverSelectPage, nav, askPage, page }) => {
    for (const mode of ["viewport", "full"] as const) {
      await page.goto(
        `/portal/select-server?visual=${mode === "full" ? "1" : "0"}`,
      );
      await serverSelectPage.openServerByName(mockGuilds.ddm.name);
      await nav.goToAsk();
      await askPage.waitForReady();
      await expectVisualScreenshot(page, "ask-list", mode);

      await askPage.switchListMode("archived");
      await askPage.waitForReady();
      await expectVisualScreenshot(page, "ask-archived", mode);

      await askPage.startNewChat();
      await expect(askPage.title()).toContainText(/new chat/i);
      if (mode === "viewport") {
        // The viewport baseline includes the navigation's hover scrollbar.
        const navigation = page.getByRole("navigation");
        await navigation.hover({ position: { x: 5, y: 5 } });
        await expect(
          navigation.locator('[data-orientation="vertical"]'),
        ).toHaveAttribute("data-state", "visible");
      }
      await expectVisualScreenshot(page, "ask-new-chat", mode);
    }
  });
}
