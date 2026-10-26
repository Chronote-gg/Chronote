import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import React from "react";
import { act, cleanup, screen } from "@testing-library/react";
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
  pricingQuery,
  billingQuery,
  setPricingQuery,
  setBillingQuery,
} from "./mocks/trpc";
import type { BasicIntroOffer } from "../../src/types/pricing";
const now = Date.parse("2026-10-14T18:00:00Z");
const offer: BasicIntroOffer = {
  status: "available",
  id: "basic_intro_v1",
  priceId: "basic",
  currency: "usd",
  regularUnitAmount: 1000,
  discountedUnitAmount: 600,
  percentOff: 40,
  durationMonths: 3,
  enrollmentEndsAt: new Date(now + 1000).toISOString(),
};
beforeEach(() => {
  resetFrontendMocks();
  jest.useFakeTimers({ now });
  authState.state = "authenticated";
  guildState.selectedGuildId = "g1";
  guildState.guilds = [{ id: "g1", name: "Team", canManage: true }];
  setRouteParams({ serverId: "g1" });
  setRouteSearch({ serverId: "g1" });
  setPricingQuery({
    data: {
      plans: [
        {
          tier: "basic",
          interval: "month",
          priceId: "basic",
          currency: "usd",
          unitAmount: 1000,
        },
        {
          tier: "pro",
          interval: "month",
          priceId: "pro",
          currency: "usd",
          unitAmount: 2400,
        },
      ],
      introOffer: offer,
    },
  });
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "free",
      status: "free",
      billingSource: "free",
      introOffer: offer,
    },
  });
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
test.each([Home, UpgradeServerSelect, Billing])(
  "fresh page closes enrollment at the exact deadline without waiting for a refetch",
  async (Component) => {
    renderWithMantine(<Component />);
    expect(
      screen.getAllByTestId("basic-intro-discount").length,
    ).toBeGreaterThan(0);
    await act(async () => {
      jest.advanceTimersByTime(999);
    });
    expect(
      screen.getAllByTestId("basic-intro-discount").length,
    ).toBeGreaterThan(0);
    await act(async () => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId("basic-intro-discount")).toBeNull();
    expect(pricingQuery.refetch).toHaveBeenCalledTimes(1);
    if (Component !== Home)
      expect(billingQuery.refetch).toHaveBeenCalledTimes(1);
  },
);
test.each([UpgradeServerSelect, Billing])(
  "an owned frozen reservation remains available beyond enrollment",
  async (Component) => {
    setBillingQuery({
      data: {
        ...billingQuery.data!,
        introOffer: { ...offer, reservedForCheckout: true },
      },
    });
    renderWithMantine(<Component />);
    await act(async () => {
      jest.advanceTimersByTime(1001);
    });
    expect(screen.getByTestId("basic-intro-discount")).toBeVisible();
    expect(screen.queryByText(/Enroll by/)).toBeNull();
    expect(billingQuery.refetch).not.toHaveBeenCalled();
  },
);
