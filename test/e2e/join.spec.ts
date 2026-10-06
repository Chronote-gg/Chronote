import { expect, test } from "./fixtures";

test("join page renders", async ({ joinPage }) => {
  await joinPage.goto();
  await expect(joinPage.hero()).toBeVisible();
  await expect(joinPage.ctaDiscord()).toBeVisible();
});

for (const width of [390, 768, 1280]) {
  test(`first recording guide at ${width}px starts in Discord and scrolls`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 600 });
    await page.goto("/join");
    await expect(
      page.getByRole("heading", { name: "Record your first meeting." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Discord" }),
    ).toHaveAttribute("href", "https://discord.com/channels/@me");
    await expect(page.getByTestId("sample-summary")).toBeVisible();
    expect(await page.locator("details").getAttribute("open")).toBeNull();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const scroll = await page.evaluate(() => {
      const element = document.scrollingElement!;
      const canScroll = element.scrollHeight > element.clientHeight;
      element.scrollTop = 200;
      return { canScroll, top: element.scrollTop };
    });
    expect(scroll.canScroll).toBe(true);
    expect(scroll.top).toBeGreaterThan(0);
    await page.getByRole("link", { name: "Open meeting library" }).click();
    await expect(page).toHaveURL(/\/portal/);
  });
}
