import { expect, test } from "./fixtures";
import { mockBilling, mockGuilds } from "./mockData";

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
