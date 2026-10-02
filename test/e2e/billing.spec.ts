import { expect, test } from "./fixtures";
import { mockBilling, mockGuilds } from "./mockData";

test("checkout return preserves the full Discord server ID and billing destination", async ({
  page,
}) => {
  await page.goto(
    `/upgrade/success?serverId=${mockGuilds.ddm.id}&plan=basic&interval=month`,
  );
  await expect(
    page.getByText(`For ${mockGuilds.ddm.name}, billed monthly.`),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: `Open ${mockGuilds.ddm.name}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Manage billing", exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/portal/server/${mockGuilds.ddm.id}/billing$`),
  );
});

test("billing page shows current plan states (mock)", async ({
  serverSelectPage,
  nav,
  billingPage,
}) => {
  await serverSelectPage.goto();
  await serverSelectPage.openServerByName(mockGuilds.ddm.name);

  await nav.goToBilling();
  await expect(billingPage.root()).toBeVisible();
  await billingPage.waitForLoaded();
  await expect(billingPage.currentPlan()).toContainText(
    mockBilling.paidTierLabel,
  );
  await expect(billingPage.manageButton()).toBeVisible();
  await billingPage.expandPlans();
  await billingPage
    .intervalToggle()
    .getByText(/annual/i)
    .click();
  await expect(billingPage.plans()).toContainText("/ yr");

  await serverSelectPage.goto();
  await serverSelectPage.openServerByName(mockGuilds.chronote.name);
  await nav.goToBilling();
  await billingPage.waitForLoaded();
  await expect(billingPage.currentPlan()).toContainText(
    mockBilling.freeTierLabel,
  );
});
