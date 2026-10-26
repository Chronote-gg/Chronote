import { renewalGraceFixture } from "../../src/frontend/pages/renewalGraceFixtures";
import {
  useFreeBilling,
  useIntroBilling,
  useRenewalGrace,
} from "./billingMocks";
import {
  annualSubscriber,
  monthlySubscriber,
} from "../../src/frontend/pages/basicIntroFixtures";
import { defaultParseSearch } from "@tanstack/react-router";
import { expect, test } from "./fixtures";
import { mockBilling, mockGuilds } from "./mockData";
import type { Locator } from "@playwright/test";

test("Free access is separate from a canceled paid subscription", async ({
  page,
}) => {
  await useFreeBilling(page, { terminalStatus: "canceled" });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const currentPlan = page.getByTestId("billing-current-plan");
  await expect(currentPlan).toContainText("Free");
  await expect(currentPlan).not.toContainText("Canceled");
  await expect(currentPlan).not.toContainText("No subscription needed");
  await expect(currentPlan).toContainText("45m / 4h");
  await expect(
    page.getByRole("button", { name: "Get Basic again" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Upgrade to Pro" }),
  ).toBeEnabled();
  const history = page.getByTestId("billing-payment-history");
  await history.getByRole("button", { name: "Payment history" }).click();
  await expect(history).toContainText("Previous subscription: Canceled");
  await expect(
    history.getByRole("button", { name: "View invoices and receipts" }),
  ).toBeEnabled();
});

const historyEntries = [
  {
    name: "billing",
    path: (id: string) => `/portal/server/${id}/billing`,
    basic: "Get Basic again",
    pro: "Upgrade to Pro",
  },
  {
    name: "direct acquisition",
    path: (id: string) => `/upgrade/select-server?serverId=${id}`,
    basic: "Continue with Basic",
    pro: "Continue with Pro",
  },
];
for (const terminalStatus of ["canceled", "incomplete_expired"] as const) {
  for (const entry of historyEntries) {
    for (const tier of ["basic", "pro"] as const) {
      test(`${terminalStatus} ${entry.name} history submits a ${tier} repurchase request`, async ({
        page,
      }) => {
        await useFreeBilling(page, { terminalStatus });
        const requests: unknown[] = [];
        await page.route("**/trpc/billing.checkout*", (route) => {
          requests.push(route.request().postDataJSON());
          return route.fulfill({
            status: 400,
            json: [
              {
                error: {
                  message: "Controlled provider rejection",
                  code: -32600,
                  data: { code: "BAD_REQUEST", httpStatus: 400 },
                },
              },
            ],
          });
        });
        await page.goto(entry.path(mockGuilds.ddm.id));
        const action = page.getByRole("button", {
          name: tier === "basic" ? entry.basic : entry.pro,
        });
        await expect(action).toBeEnabled();
        await action.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toMatchObject({
          "0": {
            serverId: mockGuilds.ddm.id,
            tier,
            interval: "month",
            expectedOffer: "none",
          },
        });
        if (entry.name === "billing") {
          await expect(page.getByTestId("billing-current-plan")).toContainText(
            "Free",
          );
          const history = page.getByTestId("billing-payment-history");
          await history
            .getByRole("button", { name: "Payment history" })
            .click();
          await expect(history).toContainText(
            terminalStatus === "canceled"
              ? "Previous subscription: Canceled"
              : "Previous subscription: Expired",
          );
          await expect(history).not.toContainText("paid");
        }
        await expect(
          page.getByRole("button", { name: "Retry checkout" }),
        ).toBeVisible();
      });
    }
  }
}

test("mobile Home stacks complete plans and keeps direct purchase actions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useIntroBilling(page);
  await page.goto("/");
  const cards = page.getByTestId("home-pricing-cards");
  await expect(cards).toBeVisible();
  const values = [
    [
      "free",
      "Free",
      "$0",
      "4 hours a week",
      "90 minutes",
      "Last 5 meetings",
      "50 a month",
      "No",
    ],
    [
      "basic",
      "Basic",
      "$6 / mo",
      "20 hours a week",
      "2 hours",
      "Last 25 meetings",
      "1,000 a month",
      "Yes",
    ],
    [
      "pro",
      "Pro",
      "$24 / mo",
      "No weekly limit",
      "2 hours",
      "Last 100 meetings",
      "Unlimited",
      "Yes",
    ],
  ];
  const labels = [
    "Recording",
    "Longest meeting",
    "Ask searches",
    "Text to speech",
    "Live voice",
  ];
  for (const [tier, title, price, ...features] of values) {
    const card = page.getByTestId(`home-plan-${tier}`);
    await expect(
      card.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
    await expect(card.getByText(price, { exact: true })).toBeVisible();
    for (const [index, value] of features.entries())
      await expect(
        card.getByText(`${labels[index]}: ${value}`, { exact: true }),
      ).toBeVisible();
  }
  await expect(page.getByTestId("basic-intro-terms")).toHaveCount(1);
  await expect(page.getByTestId("home-cta-basic")).toHaveCount(1);
  await expect(page.getByTestId("home-cta-pro")).toHaveCount(1);
  await expect(
    page.getByText("Scroll sideways to compare all plans."),
  ).toHaveCount(0);
  const bounds = await cards
    .locator(":scope > [data-testid]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return {
          top: box.top,
          bottom: box.bottom,
          left: box.left,
          right: box.right,
        };
      }),
    );
  expect(bounds).toHaveLength(3);
  expect(bounds[1].top).toBeGreaterThan(bounds[0].bottom);
  expect(bounds[2].top).toBeGreaterThan(bounds[1].bottom);
  expect(bounds.every((box) => box.left >= 0 && box.right <= 390)).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const scroll = await page.evaluate(() => {
    const element = document.scrollingElement!;
    const before = element.scrollTop;
    element.scrollTop = before + 100;
    return {
      height: element.scrollHeight,
      client: element.clientHeight,
      before,
      after: element.scrollTop,
    };
  });
  expect(scroll.height).toBeGreaterThan(scroll.client);
  expect(scroll.after).toBeGreaterThan(scroll.before);
  await page.getByTestId("home-cta-pro").click();
  await expect(page).toHaveURL(
    /plan=pro.*interval=month.*source=homepage_pricing/,
  );
  await page.goto("/");
  await page
    .getByTestId("home-billing-period")
    .getByText("Annual", { exact: true })
    .click();
  await expect(page.getByTestId("home-plan-basic")).toContainText("$60 / yr");
  await expect(page.getByTestId("home-plan-pro")).toContainText("$240 / yr");
  await page.getByTestId("home-cta-basic").click();
  await expect(page).toHaveURL(
    /plan=basic.*interval=year.*source=homepage_pricing/,
  );
});

async function expectReadableText(locator: Locator) {
  const ratios = await locator.evaluateAll((elements) =>
    elements.map((element) => {
      const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
      const luminance = (values: number[]) =>
        values
          .slice(0, 3)
          .map((value) => value / 255)
          .map((value) =>
            value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
          )
          .reduce(
            (total, value, index) =>
              total + value * [0.2126, 0.7152, 0.0722][index],
            0,
          );
      const layers: number[][] = [];
      for (
        let parent: Element | null = element;
        parent;
        parent = parent.parentElement
      )
        layers.push(channels(getComputedStyle(parent).backgroundColor));
      let background = [255, 255, 255];
      for (const layer of layers.reverse()) {
        const alpha = layer[3] ?? 1;
        background = background.map(
          (value, index) => layer[index] * alpha + value * (1 - alpha),
        );
      }
      const foreground = luminance(channels(getComputedStyle(element).color));
      const behind = luminance(background);
      return (
        (Math.max(foreground, behind) + 0.05) /
        (Math.min(foreground, behind) + 0.05)
      );
    }),
  );
  expect(ratios.length).toBeGreaterThan(0);
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
}

test("retry intent follows browser Back after a failed Annual purchase", async ({
  page,
}) => {
  const reads = { billing: 0, pricing: 0 };
  page.on("request", (request) => {
    if (request.url().includes("billing.me")) reads.billing++;
    if (request.url().includes("pricing.plans")) reads.pricing++;
  });
  await useIntroBilling(page);
  await page.route("**/trpc/billing.checkout*", (route) =>
    route.fulfill({
      status: 400,
      json: [
        {
          error: {
            message: "Controlled failed checkout",
            code: -32600,
            data: { code: "BAD_REQUEST", httpStatus: 400 },
          },
        },
      ],
    }),
  );
  await page.goto(`/upgrade/select-server?serverId=${mockGuilds.ddm.id}`);
  await page
    .getByTestId("upgrade-billing-period")
    .getByText("Annual", { exact: true })
    .click();
  await page.getByRole("button", { name: "Continue with Basic" }).click();
  await expect(
    page.getByRole("button", { name: "Retry checkout" }),
  ).toBeEnabled();
  const priorReads = { ...reads };
  await page.goBack();
  await expect(page.getByRole("radio", { name: "Monthly" })).toBeChecked();
  await expect(page.getByTestId("basic-intro-terms")).toContainText("$6/month");
  await expect(page.getByTestId("upgrade-plan-basic")).not.toContainText("$60");
  await expect(
    page.getByRole("button", { name: "Retry checkout" }),
  ).toHaveCount(0);
  await expect.poll(() => reads.billing).toBeGreaterThan(priorReads.billing);
  await expect.poll(() => reads.pricing).toBeGreaterThan(priorReads.pricing);
  await expect(
    page.getByRole("button", { name: "Continue with Basic" }),
  ).toBeEnabled();
});

test("retry intent cannot follow a failed Billing request to another server", async ({
  page,
}) => {
  await useIntroBilling(page);
  const requests: unknown[] = [];
  await page.route("**/trpc/billing.checkout*", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 400,
      json: [
        {
          error: {
            message: "Controlled failed checkout",
            code: -32600,
            data: { code: "BAD_REQUEST", httpStatus: 400 },
          },
        },
      ],
    });
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await page.getByRole("button", { name: "Upgrade to Basic" }).click();
  await expect(
    page.getByRole("button", { name: "Retry checkout" }),
  ).toBeEnabled();
  await page.evaluate(
    (path) => window.history.pushState(null, "", path),
    `/portal/server/${mockGuilds.chronote.id}/billing`,
  );
  await expect(
    page.getByText(`Server: ${mockGuilds.chronote.name}`, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry checkout" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Upgrade to Basic" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toMatchObject({
    "0": { serverId: mockGuilds.chronote.id },
  });
});

test("management-only Upgrade has no unused promotion entry", async ({
  page,
}) => {
  await useIntroBilling(page, {
    status: "ineligible",
    details: annualSubscriber,
  });
  await page.goto(
    `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&promo=SAVE20`,
  );
  await expect(
    page.getByRole("button", { name: "Manage billing" }),
  ).toBeEnabled();
  await expect(page.getByLabel("Promo code")).toHaveCount(0);
  await expect(page.getByTestId("intro-promotion-choice")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`offer and annual payment disclosures have accessible contrast in ${scheme}`, async ({
    page,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("mantine-color-scheme-value", value),
      scheme,
    );
    await useIntroBilling(page);
    await page.goto(`/upgrade/select-server?serverId=${mockGuilds.ddm.id}`);
    await expect(page.locator("html")).toHaveAttribute(
      "data-mantine-color-scheme",
      scheme,
    );
    await expect(page.getByTestId("basic-intro-terms")).toBeVisible();
    await expectReadableText(
      page.getByTestId("basic-intro-terms").locator("p"),
    );
    await expectReadableText(
      page.getByTestId("basic-intro-discount").getByLabel("Regular price"),
    );
    await expectReadableText(
      page.getByTestId("basic-intro-discount").getByText("40% off"),
    );
    await page.unroute("**/trpc/**");
    await useIntroBilling(page, {
      status: "ineligible",
      details: annualSubscriber,
    });
    await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
    await page
      .getByRole("button", { name: "Payment history", exact: true })
      .click();
    await expect(page.getByTestId("billing-payment-history")).toContainText(
      "$64.20 paid",
    );
    await expectReadableText(
      page.getByTestId("billing-payment-history").locator("p"),
    );
  });
}

for (const outcome of ["success", "error"] as const) {
  test(`late checkout ${outcome} cannot redirect or notify a different Back intent`, async ({
    page,
  }) => {
    await useIntroBilling(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let submitted = false;
    await page.route("**/trpc/billing.checkout*", async (route) => {
      submitted = true;
      await held;
      await route.fulfill(
        outcome === "success"
          ? {
              json: [
                {
                  result: {
                    data: {
                      url: `/upgrade/success?serverId=${mockGuilds.ddm.id}&interval=year`,
                    },
                  },
                },
              ],
            }
          : {
              status: 400,
              json: [
                {
                  error: {
                    message: "Controlled late error",
                    code: -32600,
                    data: { code: "BAD_REQUEST", httpStatus: 400 },
                  },
                },
              ],
            },
      );
    });
    await page.goto(`/upgrade/select-server?serverId=${mockGuilds.ddm.id}`);
    await expect(
      page.getByRole("button", { name: "Continue with Basic" }),
    ).toBeEnabled();
    await page
      .getByTestId("upgrade-billing-period")
      .getByText("Annual", { exact: true })
      .click();
    await page.getByRole("button", { name: "Continue with Basic" }).click();
    await expect.poll(() => submitted).toBe(true);
    await page.goBack();
    await expect(page.getByRole("radio", { name: "Monthly" })).toBeChecked();
    release();
    await expect(
      page.getByRole("button", { name: "Continue with Basic" }),
    ).toBeEnabled();
    await expect(page).toHaveURL(
      new RegExp(`/upgrade/select-server\\?serverId=${mockGuilds.ddm.id}$`),
    );
    await expect(
      page.getByRole("button", { name: "Retry checkout" }),
    ).toHaveCount(0);
    await expect(
      page.getByText("Controlled late error", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("basic-intro-terms")).toContainText(
      "$6/month",
    );
  });
}

test("late Billing checkout cannot redirect the newly selected server", async ({
  page,
}) => {
  await useIntroBilling(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let submitted = false;
  await page.route("**/trpc/billing.checkout*", async (route) => {
    submitted = true;
    await held;
    await route.fulfill({
      json: [
        {
          result: {
            data: {
              url: `/portal/server/${mockGuilds.ddm.id}/billing?outdated=1`,
            },
          },
        },
      ],
    });
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await page.getByRole("button", { name: "Upgrade to Basic" }).click();
  await expect.poll(() => submitted).toBe(true);
  await page.evaluate(
    (path) => window.history.pushState(null, "", path),
    `/portal/server/${mockGuilds.chronote.id}/billing`,
  );
  await expect(
    page.getByText(`Server: ${mockGuilds.chronote.name}`, { exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole("button", { name: "Upgrade to Basic" }),
  ).toBeEnabled();
  await expect(page).toHaveURL(
    new RegExp(`/portal/server/${mockGuilds.chronote.id}/billing$`),
  );
  await expect(
    page.getByRole("button", { name: "Retry checkout" }),
  ).toHaveCount(0);
});

test("purchase billing selector defaults monthly and changes totals in both directions", async ({
  page,
}) => {
  await useFreeBilling(page);
  await page.goto(
    `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&promo=SAVE20&source=discord_limit&limitType=weekly_recording&limitSurface=manual_start`,
  );
  const period = page.getByRole("radiogroup", { name: "Billing period" });
  await expect(period.getByRole("radio", { name: "Monthly" })).toBeChecked();
  await expect(period.getByText("Annual", { exact: true })).toBeVisible();
  await period.getByText("Annual", { exact: true }).click();
  await expect(page.getByTestId("upgrade-plan-basic")).toContainText(
    "$120 / yr",
  );
  await expect(page.getByTestId("upgrade-plan-basic")).toContainText(
    "Billed yearly",
  );
  let search = defaultParseSearch(new URL(page.url()).search);
  expect(search).toMatchObject({
    serverId: mockGuilds.ddm.id,
    promo: "SAVE20",
    source: "discord_limit",
    limitType: "weekly_recording",
    limitSurface: "manual_start",
    interval: "year",
  });
  await period.getByText("Monthly", { exact: true }).click();
  await expect(page.getByTestId("upgrade-plan-basic")).toContainText(
    "$12 / mo",
  );
  search = defaultParseSearch(new URL(page.url()).search);
  expect(search.interval).toBe("month");
});

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
  page,
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
  // FORCE_TIER is complimentary local access, with no payer or Stripe pointer.
  await expect(
    page.getByRole("button", { name: "Manage billing", exact: true }),
  ).toHaveCount(0);
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
      `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&plan=${tier === "basic" ? "pro" : "basic"}&interval=year&promo=SAVE20&canceled=true&source=discord_limit&limitType=weekly_recording&limitSurface=manual_start`,
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
        savedPromotionCode: "SAVE20",
        expectedOffer: "none",
        offerChoice: "automatic",
        source: "discord_limit",
        limitType: "weekly_recording",
        limitSurface: "manual_start",
      },
    });
  });
}

test("indexable purchase route keeps checkout pending during search updates", async ({
  page,
}) => {
  await useFreeBilling(page);
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/trpc/billing.checkout*", async (route) => {
    requests++;
    await pending;
    await route.fulfill({
      json: [
        {
          result: {
            data: {
              url: `/upgrade/success?serverId=${mockGuilds.ddm.id}&plan=basic&interval=month`,
            },
          },
        },
      ],
    });
  });
  await page.goto(`/upgrade?serverId=${mockGuilds.ddm.id}&plan=pro`);
  const basic = page.getByRole("button", { name: "Continue with Basic" });
  await expect(basic).toBeEnabled();
  try {
    await basic.click();
    await expect.poll(() => requests).toBe(1);
    await expect
      .poll(() => defaultParseSearch(new URL(page.url()).search).plan)
      .toBe("basic");
    expect(new URL(page.url()).pathname).toBe("/upgrade");
    await expect(basic).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Continue with Pro" }),
    ).toBeDisabled();
  } finally {
    release();
  }
  await expect(page).toHaveURL(/\/upgrade\/success/);
  expect(requests).toBe(1);
});

for (const interval of ["month", "year"] as const) {
  test(`basic intro ${interval} checkout preserves offer, explicit choice, pending guard and frozen retry`, async ({
    page,
  }) => {
    await useIntroBilling(page);
    const requests: unknown[] = [];
    await page.route("**/trpc/billing.checkout*", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 400,
        json: [
          {
            error: {
              message:
                "Checkout terms changed. Refresh offers before continuing.",
              code: -32600,
              data: { code: "BAD_REQUEST", httpStatus: 400 },
            },
          },
        ],
      });
    });
    await page.goto(
      `/upgrade/select-server?serverId=${mockGuilds.ddm.id}&interval=${interval}&promo=SAVE20&source=discord_limit&limitType=weekly_recording&limitSurface=manual_start`,
    );
    await expect(page.getByTestId("basic-intro-terms")).toContainText(
      interval === "month"
        ? "$6/month for your first 3 months, then $10/month"
        : "$60 for your first year, then $100/year",
    );
    await page.getByRole("button", { name: "Continue with Basic" }).click();
    await expect(
      page.getByRole("button", { name: "Retry checkout" }),
    ).toBeEnabled();
    expect(requests[0]).toMatchObject({
      "0": {
        expectedOffer:
          interval === "month" ? "basic_intro_v1" : "basic_annual_intro_v1",
        offerChoice: "automatic",
        savedPromotionCode: "SAVE20",
        interval,
        source: "discord_limit",
        limitType: "weekly_recording",
        limitSurface: "manual_start",
      },
    });
    expect(requests[0]).not.toMatchObject({ "0": { promotionCode: "SAVE20" } });
    await expect(page.getByRole("radio", { name: "Annual" })).toBeDisabled();
    await page.getByRole("button", { name: "Retry checkout" }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toEqual(requests[0]);
    await page.getByRole("button", { name: "Refresh offers" }).click();
    await expect(
      page.getByRole("button", { name: "Continue with Basic" }),
    ).toBeEnabled();
    await page
      .getByRole("radio", { name: "Use my promotion code instead" })
      .click();
    await page.getByRole("button", { name: "Continue with Basic" }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]).toMatchObject({
      "0": {
        expectedOffer: "none",
        offerChoice: "promotion",
        promotionCode: "SAVE20",
      },
    });
  });
}
test("basic intro Billing uses actual taxed annual invoice without account-wide warning", async ({
  page,
}) => {
  await useIntroBilling(page, {
    status: "ineligible",
    details: {
      ...annualSubscriber,
      planChangesRestricted: true,
      planChangeRestrictionEndsAt: null,
    },
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  await page
    .getByRole("button", { name: "Payment history", exact: true })
    .click();
  await expect(page.getByTestId("billing-payment-history")).toContainText(
    "$64.20 paid",
  );
  await expect(page.getByTestId("billing-current-plan")).toContainText(
    "$100/year before tax",
  );
  await expect(
    page.getByText("Account-wide plan changes are temporarily restricted"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Manage billing" }),
  ).toBeEnabled();
  await expect(page.getByLabel("Promo code")).toHaveCount(0);
});
test("basic intro Billing shows actual monthly discount and cancellation", async ({
  page,
}) => {
  await useIntroBilling(page, {
    status: "ineligible",
    details: { ...monthlySubscriber, cancelAtPeriodEnd: true },
    cancellationAt: monthlySubscriber.renewalAt,
    nextBillingDate: monthlySubscriber.renewalAt,
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const current = page.getByTestId("billing-current-plan");
  await expect(current).toContainText("$6/month before tax");
  await expect(current).toContainText("Your Basic plan ends");
  await expect(current).toContainText("Renewal off");
  await expect(current).not.toContainText("next billing");
});

test("scheduled cancellation remains visible when price details are unavailable", async ({
  page,
}) => {
  const cancellationAt = "2026-11-12T12:00:00.000Z";
  await useIntroBilling(page, {
    status: "ineligible",
    details: { status: "unavailable" },
    cancellationAt,
    nextBillingDate: cancellationAt,
  });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const current = page.getByTestId("billing-current-plan");
  await expect(current).toContainText(
    "Your Basic plan ends November 12, 2026.",
  );
  await expect(current).not.toContainText("next billing");
  await expect(
    page.getByRole("button", { name: "Manage billing" }),
  ).toBeEnabled();
});
test("basic intro unavailable quotes block signup and legacy billing stays management-only", async ({
  page,
}) => {
  await useIntroBilling(page, { status: "unavailable" });
  await page.goto(`/upgrade/select-server?serverId=${mockGuilds.ddm.id}`);
  await expect(
    page.getByRole("button", { name: "Continue with Basic" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh offers" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Pro" }),
  ).toBeEnabled();
});

test("purchase recovers unavailable server without dropping intent", async ({
  page,
}) => {
  await useFreeBilling(page);
  await page.goto(
    "/upgrade?serverId=unavailable&plan=pro&interval=year&promo=SAVE20&canceled=true&source=discord_limit&limitType=weekly_recording&limitSurface=auto_start",
  );
  expect(new URL(page.url()).pathname).toBe("/upgrade");
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
    source: "discord_limit",
    limitType: "weekly_recording",
    limitSurface: "auto_start",
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
    const period = page.getByTestId("upgrade-billing-period");
    const centered = await period.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const purchase = element
        .closest('[data-testid="upgrade-purchase"]')!
        .getBoundingClientRect();
      return Math.abs(
        control.x + control.width / 2 - purchase.x - purchase.width / 2,
      );
    });
    expect(centered).toBeLessThan(2);
    const labelHeights = await period
      .locator("label")
      .evaluateAll((labels) =>
        labels.map((label) => label.getBoundingClientRect().height),
      );
    expect(Math.max(...labelHeights) - Math.min(...labelHeights)).toBeLessThan(
      2,
    );
    for (const label of await period.locator("label").all()) {
      const box = await label.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(
        await label.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBe(true);
    }
    await period.getByText("Annual", { exact: true }).click();
    await expect(page.getByTestId("upgrade-plan-basic")).toContainText(
      "$120 / yr",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await period.getByText("Monthly", { exact: true }).click();
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

for (const terminalStatus of ["canceled", "incomplete_expired"] as const) {
  for (const entry of historyEntries) {
    for (const grantTier of ["basic", "pro"] as const) {
      test(`${terminalStatus} ${entry.name} complimentary ${grantTier} starts a paid subscription`, async ({
        page,
      }) => {
        await useFreeBilling(page, { terminalStatus, grantTier });
        const requests: unknown[] = [];
        await page.route("**/trpc/billing.checkout*", (route) => {
          requests.push(route.request().postDataJSON());
          return route.fulfill({
            status: 400,
            json: [
              {
                error: {
                  message: "Controlled provider rejection",
                  code: -32600,
                  data: { code: "BAD_REQUEST", httpStatus: 400 },
                },
              },
            ],
          });
        });
        await page.goto(entry.path(mockGuilds.ddm.id));
        const title = grantTier === "basic" ? "Basic" : "Pro";
        const name =
          entry.name === "billing"
            ? `Start paying for ${title}`
            : `Continue with ${title}`;
        const action = page.getByRole("button", { name, exact: true });
        await expect(action).toBeEnabled();
        if (entry.name === "billing")
          await expect(page.getByTestId("billing-current-plan")).toContainText(
            title,
          );
        await action.click();
        await expect.poll(() => requests.length).toBe(1);
        expect(requests[0]).toMatchObject({
          "0": {
            serverId: mockGuilds.ddm.id,
            tier: grantTier,
            interval: "month",
            expectedOffer: "none",
          },
        });
      });
    }
  }
}

for (const width of [390, 1280]) {
  test(`Home retries unavailable offer pricing at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const options: { status: "unavailable" | "inactive" } = {
      status: "unavailable",
    };
    await useIntroBilling(page, options);
    await page.goto("/");
    await expect(page.getByTestId("home-cta-pro")).toBeEnabled();
    await expect(page.getByTestId("home-cta-basic")).toBeDisabled();
    options.status = "inactive";
    await page
      .getByRole("button", { name: "Retry Basic offer", exact: true })
      .click();
    await expect(page.getByTestId("home-cta-basic")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Retry Basic offer", exact: true }),
    ).toHaveCount(0);
  });
}

for (const width of [390, 1280]) {
  test(`renewal grace confirms cancellation and allows repurchase at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const options = {
      view: renewalGraceFixture({ priorTier: "pro", scheduledChange: true }),
    };
    await useRenewalGrace(page, options);
    await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
    const notice = page.getByTestId("billing-renewal-grace");
    await expect(notice).toContainText("scheduled change to Basic");
    await expect(notice).toContainText("keep using Pro until");
    await expect(
      notice.getByRole("link", { name: "Retry payment" }),
    ).toHaveAttribute("href", options.view.paymentUrl!);
    await expect(page.getByTestId("billing-current-plan")).not.toContainText(
      "Check status",
    );
    await notice.getByRole("button", { name: "Cancel renewal" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this renewal?" });
    await expect(dialog).toContainText("unpaid plan charge will be removed");
    await expect(dialog).toContainText("Other charges stay payable");
    await dialog.getByRole("button", { name: "Cancel renewal" }).click();
    await expect(notice).toContainText("Renewal canceled");
    await expect(notice).toContainText("keep using Pro until");
    await expect(
      page.getByRole("button", { name: "Get Basic again" }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Get Pro again" }),
    ).toBeEnabled();
    if (width === 390) {
      const cards = await page
        .locator('[data-testid^="billing-plan-"]')
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
          }),
        );
      expect(cards).toHaveLength(3);
      expect(cards[1].top).toBeGreaterThanOrEqual(cards[0].bottom);
      expect(cards[2].top).toBeGreaterThanOrEqual(cards[1].bottom);
      const scroll = await page.getByRole("main").evaluate((element) => {
        element.scrollTop = 0;
        const canScroll = element.scrollHeight > element.clientHeight;
        element.scrollTop = 200;
        return { canScroll, top: element.scrollTop };
      });
      expect(scroll.canScroll).toBe(true);
      expect(scroll.top).toBeGreaterThan(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}
test("renewal payment processing stays quiet and refreshes after actual settlement", async ({
  page,
}) => {
  const options: {
    view: import("../../src/types/renewalRecovery").RenewalRecoveryView;
  } = {
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
  options.view = { status: "none" };
  await notice.getByRole("button", { name: "Refresh status" }).click();
  await expect(notice).toHaveCount(0);
});
test("renewal grace removes payment actions at the exact deadline", async ({
  page,
}) => {
  const view = renewalGraceFixture();
  const deadline = Date.parse(view.endsAt!);
  await page.clock.install({ time: new Date(deadline - 60_000) });
  await useRenewalGrace(page, { view });
  await page.goto(`/portal/server/${mockGuilds.ddm.id}/billing`);
  const notice = page.getByTestId("billing-renewal-grace");
  await expect(
    notice.getByRole("link", { name: "Retry payment" }),
  ).toBeVisible();
  await page.clock.pauseAt(new Date(deadline - 1000));
  await expect(
    notice.getByRole("link", { name: "Retry payment" }),
  ).toBeVisible();
  await page.clock.runFor(999);
  await expect(
    notice.getByRole("link", { name: "Retry payment" }),
  ).toBeVisible();
  await page.clock.runFor(1);
  await expect(notice.getByRole("link", { name: "Retry payment" })).toHaveCount(
    0,
  );
  await expect(notice).toContainText("Your server is now on Free");
});
