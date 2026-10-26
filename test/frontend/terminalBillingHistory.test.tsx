import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import React from "react";
import { beforeEach, describe, expect, test } from "@jest/globals";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  billingCheckoutMutation,
  setBillingQuery,
  setPricingQuery,
} from "./mocks/trpc";

function prepare(status: string) {
  authState.state = "authenticated";
  guildState.selectedGuildId = "g1";
  guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
  setRouteParams({ serverId: "g1" });
  setRouteSearch({ serverId: "g1" });
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "free",
      status,
      billingSource: "free",
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
}
describe.each([
  {
    name: "Billing",
    Page: Billing,
    basic: "Get Basic again",
    pro: "Upgrade to Pro",
  },
  {
    name: "Direct upgrade",
    Page: UpgradeServerSelect,
    basic: "Continue with Basic",
    pro: "Continue with Pro",
  },
])("$name terminal history", ({ Page, basic, pro }) => {
  beforeEach(resetFrontendMocks);
  test.each(["canceled", "incomplete_expired"])(
    "%s history permits a new purchase request",
    async (status) => {
      prepare(status);
      renderWithMantine(<Page />);
      expect(screen.getByRole("button", { name: basic })).toBeEnabled();
      expect(screen.getByRole("button", { name: pro })).toBeEnabled();
      await userEvent.click(screen.getByRole("button", { name: basic }));
      expect(billingCheckoutMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: "g1",
          tier: "basic",
          interval: "month",
        }),
      );
    },
  );
  test.each(["active", "past_due", "unpaid", "incomplete", "paused"])(
    "%s pointer cannot start replacement Checkout",
    (status) => {
      prepare(status);
      renderWithMantine(<Page />);
      expect(
        screen.getByRole("button", {
          name: Page === Billing ? "Upgrade to Basic" : basic,
        }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: pro })).toBeDisabled();
      expect(billingCheckoutMutation.mutateAsync).not.toHaveBeenCalled();
    },
  );
});
describe("Expired subscription history copy", () => {
  beforeEach(resetFrontendMocks);
  test("does not describe an expired initial payment as a paid subscription", () => {
    prepare("incomplete_expired");
    renderWithMantine(<Billing />);
    expect(screen.getByTestId("billing-current-plan")).toHaveTextContent(
      "Free",
    );
    expect(screen.getByTestId("billing-payment-history")).toHaveTextContent(
      "Previous subscription: Expired",
    );
    expect(screen.getByTestId("billing-payment-history")).not.toHaveTextContent(
      "paid",
    );
  });
});

describe.each([
  { name: "Billing", Page: Billing, actionName: "Start paying for Basic" },
  {
    name: "Direct upgrade",
    Page: UpgradeServerSelect,
    actionName: "Continue with Basic",
  },
])("$name complimentary terminal history", ({ Page, actionName }) => {
  beforeEach(resetFrontendMocks);
  test.each(["canceled", "incomplete_expired"])(
    "%s history permits paying without replacing the complimentary current plan",
    async (stripeStatus) => {
      prepare(stripeStatus);
      setBillingQuery({
        data: {
          billingEnabled: true,
          tier: "basic",
          status: "comped",
          stripeStatus,
          billingSource: "manual_comp",
          hasStripeBilling: true,
          canManageBillingPortal: true,
          grantTier: "basic",
          usage: null,
        },
      });
      renderWithMantine(<Page />);
      const action = screen.getByRole("button", { name: actionName });
      expect(action).toBeEnabled();
      await userEvent.click(action);
      expect(billingCheckoutMutation.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ serverId: "g1", tier: "basic" }),
      );
      if (Page === Billing)
        expect(screen.getByTestId("billing-current-plan")).toHaveTextContent(
          "Basic",
        );
    },
  );
});

describe.each([
  { name: "Billing", Page: Billing, actionName: "Start paying for Basic" },
  {
    name: "Direct upgrade",
    Page: UpgradeServerSelect,
    actionName: "Continue with Basic",
  },
])("$name complimentary active billing", ({ Page, actionName }) => {
  beforeEach(resetFrontendMocks);
  test.each(["active", "past_due", null])(
    "does not bypass management for raw Stripe state %s",
    (stripeStatus) => {
      prepare("comped");
      setBillingQuery({
        data: {
          billingEnabled: true,
          tier: "basic",
          status: "comped",
          stripeStatus,
          billingSource: "manual_comp",
          hasStripeBilling: true,
          canManageBillingPortal: true,
          usage: null,
        },
      });
      renderWithMantine(<Page />);
      expect(screen.getByRole("button", { name: actionName })).toBeDisabled();
      expect(billingCheckoutMutation.mutateAsync).not.toHaveBeenCalled();
    },
  );
});
