import { expect, test } from "./fixtures";

test("join page renders", async ({ joinPage }) => {
  await joinPage.goto();
  await expect(joinPage.hero()).toBeVisible();
  await expect(joinPage.ctaDiscord()).toBeVisible();
});
