import { expect, test } from "./fixtures";
import { testIds } from "./pages/testIds";

test("admin feedback loads from admin home (mock)", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByTestId("admin-home-page")).toBeVisible();
  await page.getByTestId(testIds.adminHome.feedback).click();
  await expect(page.getByTestId(testIds.adminFeedback.page)).toBeVisible();
  await expect(page.getByText("Clear summary and next steps.")).toBeVisible();
  await expect(page.getByText("Display name: MockUser")).toBeVisible();
  await expect(page.getByText("Discord username: MockUser#0001")).toBeVisible();
  await expect(
    page.getByText("Guild: DDM (1249723747896918109)"),
  ).toBeVisible();
});
