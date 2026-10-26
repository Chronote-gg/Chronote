import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import { act, fireEvent, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import Home from "../../src/frontend/pages/Home";
import Billing from "../../src/frontend/pages/Billing";
import UpgradeServerSelect from "../../src/frontend/pages/UpgradeServerSelect";
import {
  authState,
  guildState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouteSearch,
} from "./testUtils";
import {
  setBillingQuery,
  setPricingQuery,
  billingCheckoutMutation,
} from "./mocks/trpc";
import { track } from "../../src/frontend/services/analytics";
import type { BasicIntroOffer, PaidPlan } from "../../src/types/pricing";
jest.mock("../../src/frontend/services/analytics", () => ({
  track: jest.fn(),
  isDoNotTrackEnabled: () => false,
}));

const monthly: BasicIntroOffer = {
  status: "available",
  id: "basic_intro_v1",
  priceId: "price_month",
  currency: "usd",
  percentOff: 40,
  regularUnitAmount: 1000,
  discountedUnitAmount: 600,
  durationMonths: 3,
  enrollmentEndsAt: null,
};
const annual: BasicIntroOffer = {
  status: "available",
  id: "basic_annual_intro_v1",
  priceId: "price_year",
  currency: "usd",
  percentOff: 40,
  regularUnitAmount: 10000,
  discountedUnitAmount: 6000,
  durationMonths: 12,
  enrollmentEndsAt: null,
};
const plans: PaidPlan[] = [
  {
    tier: "basic",
    interval: "month",
    priceId: "price_month",
    unitAmount: 1000,
    currency: "usd",
  },
  {
    tier: "basic",
    interval: "year",
    priceId: "price_year",
    unitAmount: 10000,
    currency: "usd",
  },
  {
    tier: "pro",
    interval: "month",
    priceId: "price_pro_month",
    unitAmount: 2400,
    currency: "usd",
  },
  {
    tier: "pro",
    interval: "year",
    priceId: "price_pro_year",
    unitAmount: 24000,
    currency: "usd",
  },
];
let callback: IntersectionObserverCallback;
beforeEach(() => {
  resetFrontendMocks();
  jest.mocked(track).mockClear();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  global.IntersectionObserver = jest.fn((fn) => {
    callback = fn;
    return {
      observe: jest.fn(),
      disconnect: jest.fn(),
      unobserve: jest.fn(),
      takeRecords: () => [],
      root: null,
      rootMargin: "0px",
      scrollMargin: "0px",
      thresholds: [1],
    };
  });
  authState.state = "authenticated";
  guildState.selectedGuildId = "g1";
  guildState.guilds = [{ id: "g1", name: "Server", canManage: true }];
  setRouteParams({ serverId: "g1" });
  setRouteSearch({ serverId: "g1" });
  setPricingQuery({
    data: { plans, introOffer: monthly, annualIntroOffer: annual },
  });
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "free",
      status: "free",
      billingSource: "free",
      hasStripeBilling: false,
      introOffer: monthly,
      annualIntroOffer: annual,
    },
  });
});
function expose(ratio = 1) {
  const target = screen.getByTestId("basic-intro-terms");
  act(() =>
    callback(
      [
        {
          target,
          intersectionRatio: ratio,
          isIntersecting: true,
          boundingClientRect: { width: 290, height: 100 },
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    ),
  );
}
test.each([
  ["homepage_pricing", Home],
  ["upgrade", UpgradeServerSelect],
  ["portal_billing", Billing],
] as const)(
  "actual %s disclosure waits for full visibility",
  (surface, Page) => {
    renderWithMantine(<Page />);
    expect(track).not.toHaveBeenCalledWith(
      "basic_intro_offer_exposed",
      expect.anything(),
    );
    expose(0.75);
    expect(track).not.toHaveBeenCalledWith(
      "basic_intro_offer_exposed",
      expect.anything(),
    );
    expose();
    expect(track).toHaveBeenCalledWith(
      "basic_intro_offer_exposed",
      expect.objectContaining({
        surface,
        offer: "basic_intro_v1",
        interval: "month",
      }),
    );
  },
);
test("mounted Upgrade counts annual once and does not reset monthly on cadence queries", () => {
  const view = renderWithMantine(<UpgradeServerSelect />);
  expose();
  act(() => setRouteSearch({ serverId: "g1", interval: "year" }));
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expose();
  act(() => setRouteSearch({ serverId: "g1", interval: "month" }));
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expose();
  expect(
    jest
      .mocked(track)
      .mock.calls.filter(([event]) => event === "basic_intro_offer_exposed"),
  ).toHaveLength(2);
});
test("Billing action sends the displayed fixed annual offer and only code presence", () => {
  billingCheckoutMutation.mutateAsync.mockImplementation(
    () => new Promise(() => {}),
  );
  setRouteSearch({ serverId: "g1", interval: "year", promo: "PRIVATE" });
  renderWithMantine(<Billing />);
  fireEvent.click(screen.getByRole("button", { name: "Upgrade to Basic" }));
  expect(track).toHaveBeenCalledWith(
    "upgrade_plan_clicked",
    expect.objectContaining({
      offer: "basic_annual_intro_v1",
      promo_present: true,
      interval: "year",
    }),
  );
  expect(JSON.stringify(jest.mocked(track).mock.calls)).not.toContain(
    "PRIVATE",
  );
});
test("paid Billing remains a management entry without purchase readiness", () => {
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "basic",
      status: "active",
      billingSource: "stripe",
      hasStripeBilling: true,
      canManageBillingPortal: true,
    },
  });
  renderWithMantine(<UpgradeServerSelect />);
  expect(
    screen.getByRole("button", { name: "Continue with Pro" }),
  ).toBeDisabled();
  expect(track).not.toHaveBeenCalledWith("upgrade_ready", expect.anything());
  expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
  expect(billingCheckoutMutation.mutateAsync).not.toHaveBeenCalled();
});

test("blocked Upgrade events do not carry the offer property", () => {
  authState.state = "unauthenticated";
  renderWithMantine(<UpgradeServerSelect />);
  const blocked = jest
    .mocked(track)
    .mock.calls.filter(([event]) => event === "upgrade_blocked");
  expect(blocked).toHaveLength(1);
  expect(blocked[0][1]).toMatchObject({
    reason: "auth_required",
    event_version: 1,
  });
  expect(blocked[0][1]).not.toHaveProperty("offer");
});
