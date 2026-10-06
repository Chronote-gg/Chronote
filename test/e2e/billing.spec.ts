import { useFreeBilling } from "./billingMocks";
import { defaultParseSearch } from "@tanstack/react-router";
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

for (const tier of ["basic", "pro"] as const) {
  test(`purchase submits ${tier} directly and preserves annual promotion intent`, async ({
    page,
  }) => {
    await useFreeBilling(page);
    let submitted: unknown;
    await page.route("**/trpc/billing.checkout*", async (route) => {
      submitted = route.request().postDataJSON();
      await route.fulfill({
        json: [
          {
            result: {
              data: {
                url: `/upgrade/success?serverId=${mockGuilds.ddm.id}&plan=${tier}&interval=year`,
              },
            },
          },
        ],
      });
    });
    await page.goto(
      `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&plan=${tier === "basic" ? "pro" : "basic"}&interval=year&promo=SAVE20&canceled=true&source=discord_notes`,
    );
    const action = page.getByRole("button", {
      name: `Continue with ${tier === "basic" ? "Basic" : "Pro"}`,
    });
    await expect(action).toBeEnabled();
    await action.click();
    await expect(page).toHaveURL(/\/upgrade\/success/);
    expect(submitted).toEqual({
      "0": {
        serverId: mockGuilds.ddm.id,
        tier,
        interval: "year",
        promotionCode: "SAVE20",
        source: "discord_notes",
      },
    });
  });
}

test("purchase recovers unavailable server without dropping intent", async ({
  page,
}) => {
  await useFreeBilling(page);
  await page.goto(
    "/upgrade?serverId=unavailable&plan=pro&interval=year&promo=SAVE20&canceled=true",
  );
  await expect(page).toHaveURL(/\/upgrade\/select-server/);
  await expect(page.getByText("That server is unavailable")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Pro" }),
  ).toBeDisabled();
  await page
    .getByTestId("upgrade-server-card")
    .filter({ hasText: mockGuilds.ddm.name })
    .getByRole("button", { name: "Select server" })
    .click();
  await expect(
    page.getByRole("button", { name: "Continue with Pro" }),
  ).toBeEnabled();
  const search = defaultParseSearch(new URL(page.url()).search);
  expect(search).toMatchObject({
    serverId: mockGuilds.ddm.id,
    plan: "pro",
    interval: "year",
    promo: "SAVE20",
    canceled: true,
  });
});

test("homepage plan link reaches the same comparison without auto-checkout", async ({
  page,
}) => {
  await useFreeBilling(page);
  await page.goto("/");
  await page.getByTestId("home-cta-pro").click();
  await expect(page).toHaveURL(/upgrade\/select-server.*plan=pro/);
  await expect(page.getByTestId("upgrade-plan-free")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Pro" }),
  ).toBeDisabled();
});

for (const width of [320, 768, 993, 1199, 1201, 1280]) {
  test(`purchase keeps three equal cards or one stack and reachable header at ${width}px`, async ({
    page,
  }) => {
    await useFreeBilling(page);
    await page.setViewportSize({ width, height: 600 });
    await page.goto(`/upgrade/select-server?serverId=${mockGuilds.ddm.id}`);
    await expect(
      page.getByRole("button", { name: "Continue with Basic" }),
    ).toBeEnabled();
    await expect(
      page.getByText("Your subscription helps keep Chronote running.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText(/running for communities on Free/)).toHaveCount(
      0,
    );
    const cards = await page
      .getByTestId("upgrade-plans")
      .locator(".mantine-Paper-root")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const { y, width, height } = element.getBoundingClientRect();
          return { y, width, height };
        }),
      );
    expect(cards).toHaveLength(3);
    expect(
      Math.max(...cards.map((c) => c.width)) -
        Math.min(...cards.map((c) => c.width)),
    ).toBeLessThan(2);
    if (width < 1200) {
      expect(cards[1].y).toBeGreaterThanOrEqual(cards[0].y + cards[0].height);
      expect(cards[2].y).toBeGreaterThanOrEqual(cards[1].y + cards[1].height);
    } else
      expect(
        Math.max(...cards.map((c) => c.y)) - Math.min(...cards.map((c) => c.y)),
      ).toBeLessThan(2);
    const bullets = await page
      .getByTestId("upgrade-plan-free")
      .getByRole("listitem")
      .evaluateAll((items) =>
        items.map((item) => {
          const { top, bottom } = item.getBoundingClientRect();
          return { top, bottom };
        }),
      );
    for (let i = 1; i < bullets.length; i++)
      expect(bullets[i].top).toBeGreaterThanOrEqual(bullets[i - 1].bottom);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (width <= 768) {
      const menu = page.getByRole("button", { name: "Open account menu" });
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await menu.click();
      await expect(
        page.getByRole("menuitem", { name: "Switch account" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const scroll = await page.evaluate(() => {
      const element = document.scrollingElement!;
      const canScroll = element.scrollHeight > element.clientHeight;
      element.scrollTop = 200;
      return { canScroll, top: element.scrollTop };
    });
    expect(scroll.canScroll).toBe(true);
    expect(scroll.top).toBeGreaterThan(0);
  });
}
