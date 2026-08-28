import { expect, test } from "./fixtures";
import { mockGuilds, mockSettings } from "./mockData";

const teachingDrafts = Array.from({ length: 6 }, (_, index) => ({
  draftId: `11111111-1111-4111-8111-11111111111${index}`,
  preferredTerm: index === 0 ? "Jon Smythe" : `Project term ${index + 1}`,
  observedForms: index === 0 ? ["John Smith"] : [],
  description: "Server-specific vocabulary used during product meetings",
  ambiguity: null,
  evidence: [
    {
      source: "instruction",
      quote: index === 0 ? "Jon Smythe" : `Project term ${index + 1}`,
    },
  ],
  action: "create",
}));

test("dictionary teaching review remains scrollable", async ({
  page,
  serverSelectPage,
  nav,
  settingsPage,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.route("**/trpc/dictionary.previewTeaching**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          result: {
            data: {
              token: "22222222-2222-4222-8222-222222222222",
              expiresAtMs: Date.now() + 15 * 60 * 1_000,
              drafts: teachingDrafts,
            },
          },
        },
      ]),
    });
  });

  await serverSelectPage.goto();
  await serverSelectPage.openServerByName(mockGuilds.ddm.name);
  await nav.goToSettings();
  await settingsPage.waitForLoaded(
    mockSettings.overrideChannelName || undefined,
  );

  const dictionary = page.getByTestId("settings-dictionary");
  await dictionary.scrollIntoViewIfNeeded();
  await dictionary.getByRole("button", { name: "Teach Chronote" }).click();
  await page
    .getByTestId("dictionary-teaching-input")
    .fill("John Smith should be spelled Jon Smythe.");
  await page.getByRole("button", { name: "Review terms" }).click();

  await expect(page.locator('input[value="Jon Smythe"]')).toBeVisible();
  const viewport = page
    .getByTestId("dictionary-teaching-review-scroll")
    .locator(".mantine-ScrollArea-viewport");
  const metrics = await viewport.evaluate((element) => ({
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

  await viewport.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(async () => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(metrics.scrollTop);
});
