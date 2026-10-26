import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen, within } from "@testing-library/react";
import {
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
} from "./testUtils";
import { guildState } from "./testUtils";
import {
  billingRenewalQuery,
  setBillingQuery,
  setPricingQuery,
  billingCheckoutMutation,
} from "./mocks/trpc";
import userEvent from "@testing-library/user-event";
import Billing from "../../src/frontend/pages/Billing";

describe("Billing page", () => {
  beforeEach(() => {
    resetFrontendMocks();
    setRouteParams({ serverId: "g1" });
    setPricingQuery({ data: { plans: [] } });
    billingRenewalQuery.data = {
      state: { kind: "terminal" },
      canManageBilling: true,
      lifecycleAnalyticsEnabled: false,
    };
  });

  test("renders no server state when nothing is selected", () => {
    guildState.selectedGuildId = null;
    setBillingQuery({ data: null, isLoading: false, error: null });
    renderWithMantine(<Billing />);
    expect(
      screen.getByText(/Select a server to view billing/i),
    ).toBeInTheDocument();
  });

  test("a Free server with existing Stripe billing retains its management action", () => {
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setBillingQuery({
      data: {
        billingEnabled: true,
        tier: "free",
        status: "canceled",
        hasStripeBilling: true,
        canManageBillingPortal: true,
        usage: null,
      },
    });
    renderWithMantine(<Billing />);
    expect(
      screen.getByRole("button", { name: "View invoices and receipts" }),
    ).toBeVisible();
    expect(screen.getByTestId("billing-current-plan")).not.toHaveTextContent(
      "Canceled",
    );
    expect(screen.getByTestId("billing-payment-history")).toHaveTextContent(
      "Previous subscription: Canceled",
    );
    expect(
      screen.queryByText("No subscription needed"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId("billing-current-plan")).getByText("Free", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test.each(["basic", "pro"] as const)(
    "canceled paid history keeps the %s purchase request available",
    async (tier) => {
      guildState.selectedGuildId = "g1";
      guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
      setBillingQuery({
        data: {
          billingEnabled: true,
          tier: "free",
          status: "canceled",
          hasStripeBilling: true,
          canManageBillingPortal: true,
          usage: null,
        },
      });
      setPricingQuery({
        data: {
          plans: [
            {
              tier: "basic",
              interval: "month",
              priceId: "basic",
              unitAmount: 1000,
              currency: "usd",
            },
            {
              tier: "pro",
              interval: "month",
              priceId: "pro",
              unitAmount: 2400,
              currency: "usd",
            },
          ],
        },
      });
      billingCheckoutMutation.mutateAsync.mockRejectedValue(
        new Error("Controlled provider rejection"),
      );
      renderWithMantine(<Billing />);
      const button = screen.getByRole("button", {
        name: tier === "basic" ? "Get Basic again" : "Upgrade to Pro",
      });
      expect(button).toBeEnabled();
      await userEvent.click(button);
      expect(billingCheckoutMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: "g1", tier, interval: "month" }),
      );
      expect(screen.getByTestId("billing-payment-history")).toHaveTextContent(
        "Canceled",
      );
    },
  );

  test("renders disabled billing state", () => {
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setBillingQuery({
      data: {
        billingEnabled: false,
        tier: "free",
        status: "disabled",
        nextBillingDate: null,
        usage: null,
      },
    });
    renderWithMantine(<Billing />);
    expect(screen.getByText(/Billing disabled/i)).toBeInTheDocument();
  });

  test("renders paid plan status line", () => {
    guildState.selectedGuildId = "g1";
    guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
    setBillingQuery({
      data: {
        billingEnabled: true,
        tier: "pro",
        status: "active",
        nextBillingDate: "2025-12-31T00:00:00.000Z",
        usage: { usedMinutes: 30, limitMinutes: 60 },
      },
    });
    renderWithMantine(<Billing />);
    const currentPanel = screen.getByTestId("billing-current-plan");
    expect(within(currentPanel).getByText("Current plan")).toBeInTheDocument();
    expect(screen.getByText(/next billing/i)).toBeInTheDocument();
  });

  test.each([
    {
      label: "a known provider price",
      plans: [
        {
          tier: "basic",
          interval: "month",
          priceId: "price_basic",
          unitAmount: 1000,
          currency: "usd",
        },
      ],
      copy: "This is normally $10 / mo.",
      canStart: true,
    },
    {
      label: "missing catalog pricing",
      plans: [],
      copy: "Regular pricing is unavailable right now.",
      canStart: false,
    },
  ])(
    "renders comped plan copy with $label without Stripe management",
    ({ plans, copy, canStart }) => {
      guildState.selectedGuildId = "g1";
      guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
      setBillingQuery({
        data: {
          billingEnabled: true,
          tier: "basic",
          status: "comped",
          billingSource: "manual_comp",
          stripeTier: null,
          grantTier: "basic",
          activeGrant: {
            grantId: "grant-1",
            guildId: "g1",
            tier: "basic",
            status: "active",
            source: "manual_comp",
            startsAt: "2026-06-12T00:00:00.000Z",
            publicNote: "Thanks for trying Chronote.",
          },
          nextBillingDate: null,
          subscriptionId: null,
          customerId: null,
          hasStripeBilling: false,
          canManageBillingPortal: false,
          usage: { usedMinutes: 30, limitMinutes: 1200 },
        },
      });
      setPricingQuery({ data: { plans } });
      renderWithMantine(<Billing />);
      expect(screen.getByText(/comped by Chronote/i)).toBeInTheDocument();
      expect(screen.getByText(copy, { exact: false })).toBeInTheDocument();
      expect(
        within(screen.getByTestId("billing-current-plan")).getByText(
          /Chronote has granted this server Basic for free\./i,
        ),
      ).toBeVisible();
      expect(
        within(screen.getByTestId("billing-current-plan")).getByText(
          "Included in this plan",
        ),
      ).toBeVisible();
      expect(screen.getByTestId("billing-current-plan")).toHaveTextContent(
        "Recording time per rolling week: 20 hours",
      );
      expect(
        screen.queryByText(/normally Pricing unavailable/i),
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId("billing-manage")).not.toBeInTheDocument();
      expect(screen.getByText(/Start paying for Basic/i)).toBeVisible();
      const startPaying = screen.getByRole("button", {
        name: "Start paying for Basic",
      });
      if (canStart) expect(startPaying).toBeEnabled();
      else expect(startPaying).toBeDisabled();
    },
  );
});
