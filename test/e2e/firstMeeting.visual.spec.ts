import { expect, test } from "./fixtures";
import { mockFirstMeetingRequests } from "./firstMeetingMocks";
import { mockGuilds } from "./mockData";
import { applyVisualDefaults, waitForVisualReady } from "./visualUtils";
import { assertPageCanScroll } from "./scrollAssertions";

const serverId = mockGuilds.ddm.id;
const meeting = {
  historyId: "111111111111111111#2024-12-31T12:00:00.000Z",
  title: "Engineering weekly planning",
  portalUrl: `http://127.0.0.1:5173/portal/meetings/${serverId}/111111111111111111%232024-12-31T12%3A00%3A00.000Z`,
  discordUrl: `https://discord.com/channels/${serverId}/222222222222222222/333333333333333333`,
  captureNotice: "Some audio could not be captured.",
  recoveryNotice: "Recording recovered after an interruption.",
};
test.describe("first-meeting page layouts", () => {
  test.skip(process.env.PW_VISUAL !== "true", "Visual regression disabled");
  for (const width of [390, 1280]) {
    const ready = width === 1280;
    const name = ready ? "ready" : "unknown";
    test(`${name} dark ${width}px @visual`, async ({ page }) => {
      await page.setViewportSize({ width, height: 720 });
      await applyVisualDefaults(page);
      await page.addInitScript(() =>
        localStorage.setItem("mantine-color-scheme-value", "dark"),
      );
      await mockFirstMeetingRequests(page, {
        "meetings.firstMeeting": () =>
          ready ? { kind: "ready", meeting } : { kind: "guide" },
      });
      await page.goto(`/join${ready ? `?serverId=${serverId}` : ""}`);
      await expect(
        page.getByRole("heading", {
          name: ready ? "Your notes are ready" : "Record your first meeting.",
          exact: true,
        }),
      ).toBeVisible();
      const action = page.getByRole("link", {
        name: ready ? "Open meeting" : "Open Discord",
        exact: true,
      });
      if (ready)
        await expect(action).toHaveAttribute("href", meeting.portalUrl);
      await action.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      await expect(action).toBeFocused();
      await assertPageCanScroll(page);
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForVisualReady(page);
      await expect(page).toHaveScreenshot(
        `first-meeting-${name}-dark-${width}.png`,
        {
          fullPage: true,
          maxDiffPixels: 200,
        },
      );
    });
  }
});
