import React from "react";
import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import userEvent from "@testing-library/user-event";
import { screen, waitFor } from "@testing-library/react";
import type { PaidPlan } from "../../src/types/pricing";
import { renderWithMantine, resetFrontendMocks } from "./testUtils";
import { pricingQuery, setPricingQuery } from "./mocks/trpc";
import Home from "../../src/frontend/pages/Home";

describe("Home page", () => {
  beforeEach(() => {
    resetFrontendMocks();
  });

  test("renders pricing unavailable when plans are missing", () => {
    setPricingQuery({ data: { plans: [] } });
    renderWithMantine(<Home />);
    const unavailable = screen.getAllByText("Pricing unavailable");
    expect(unavailable.length).toBeGreaterThan(0);
  });

  test("renders monthly pricing when annual plans exist", () => {
    const plans: PaidPlan[] = [
      {
        tier: "basic",
        interval: "month",
        priceId: "price_basic_month",
        unitAmount: 2000,
        currency: "usd",
      },
      {
        tier: "basic",
        interval: "year",
        priceId: "price_basic_year",
        unitAmount: 20000,
        currency: "usd",
      },
      {
        tier: "pro",
        interval: "month",
        priceId: "price_pro_month",
        unitAmount: 4000,
        currency: "usd",
      },
    ];
    setPricingQuery({ data: { plans } });
    renderWithMantine(<Home />);
    expect(screen.getByText("$20 / mo")).toBeInTheDocument();
    expect(screen.getByText("$40 / mo")).toBeInTheDocument();
    expect(screen.queryByText("Pricing unavailable")).toBeNull();
  });
});

describe.each(["cards", "table"])("Home unavailable offer in %s", (layout) => {
  beforeEach(() => {
    jest.restoreAllMocks();
    resetFrontendMocks();
  });
  test.each(["month", "year"])(
    "blocks Basic for the selected %s offer while Pro stays available",
    async (interval) => {
      const original = window.matchMedia.bind(window);
      jest.spyOn(window, "matchMedia").mockImplementation((query) => ({
        ...original(query),
        matches: query.includes("min-width") && layout === "table",
      }));
      const plans: PaidPlan[] = [
        {
          tier: "basic",
          interval: "month",
          priceId: "bm",
          unitAmount: 1000,
          currency: "usd",
        },
        {
          tier: "basic",
          interval: "year",
          priceId: "by",
          unitAmount: 10000,
          currency: "usd",
        },
        {
          tier: "pro",
          interval: "month",
          priceId: "pm",
          unitAmount: 2400,
          currency: "usd",
        },
        {
          tier: "pro",
          interval: "year",
          priceId: "py",
          unitAmount: 24000,
          currency: "usd",
        },
      ];
      setPricingQuery({
        data: {
          plans,
          introOffer: {
            status: interval === "month" ? "unavailable" : "inactive",
          },
          annualIntroOffer: {
            status: interval === "year" ? "unavailable" : "inactive",
          },
        },
      });
      renderWithMantine(<Home />);
      if (interval === "year")
        await userEvent.click(screen.getByText("Annual", { exact: true }));
      expect(screen.getByTestId("home-cta-basic")).toBeDisabled();
      expect(screen.getByTestId("home-cta-pro")).toBeEnabled();
      await userEvent.click(
        screen.getByRole("button", { name: "Retry Basic offer" }),
      );
      await waitFor(() =>
        expect(pricingQuery.refetch).toHaveBeenCalledTimes(1),
      );
    },
  );
});
