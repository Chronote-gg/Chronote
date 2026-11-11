import { renewalGraceFixture } from "../../src/frontend/pages/renewalGraceFixtures";
import { useRenewalGrace } from "./billingMocks";
import { expect, test } from "./fixtures";
import { mockGuilds } from "./mockData";

test("renewal payment processing stays quiet and refreshes after actual settlement", async ({
  page,
}) => {
  await page.clock.install();
  const options: Parameters<typeof useRenewalGrace>[1] = {
    view: renewalGraceFixture({
      status: "settlement_pending",
      paymentUrl: null,
    }),
  };
  await useRenewalGrace(page, options);
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const notice = page.getByTestId("billing-renewal-grace");
  await expect(notice).toContainText("payment is still being settled");
  await expect(notice.getByRole("link", { name: "Retry payment" })).toHaveCount(
    0,
  );
  await page.clock.pauseAt(Date.now() + 1000);
  options.view = { status: "none" };
  await notice.getByRole("button", { name: "Refresh status" }).click();
  await page.clock.resume();
  await expect(notice).toHaveCount(0);
});
