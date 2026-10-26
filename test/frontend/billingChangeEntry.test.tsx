import "./mocks/mockFrontendContexts";
import "./mocks/mockRouter";
import "./mocks/trpc";
import React from "react";
import { MantineProvider } from "@mantine/core";
import { beforeEach, expect, it } from "@jest/globals";
import { act, fireEvent, screen, within } from "@testing-library/react";
import Billing from "../../src/frontend/pages/Billing";
import {
  annualIntroOffer,
  introPlans,
} from "../../src/frontend/pages/basicIntroFixtures";
import {
  authState,
  guildState,
  renderWithMantine,
  resetFrontendMocks,
  setRouteParams,
  setRouteSearch,
  navigateSpy,
} from "./testUtils";
import {
  billingRenewalCancelMutation,
  billingChangePrepare,
  billingChangeQuery,
  billingRenewalQuery,
  setBillingQuery,
  setPricingQuery,
} from "./mocks/trpc";
beforeEach(resetFrontendMocks);
it("keeps the direct annual selection until pricing can identify its offer", async () => {
  authState.state = "authenticated";
  guildState.selectedGuildId = "g1";
  guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
  setRouteParams({ serverId: "g1" });
  setRouteSearch({ plan: "basic", interval: "year" });
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "pro",
      status: "active",
      billingSource: "stripe",
      hasStripeBilling: true,
      canManageBillingPortal: true,
      annualIntroOffer,
    },
  });
  billingRenewalQuery.data = {
    state: { kind: "not_applicable" },
    canManageBilling: true,
    lifecycleAnalyticsEnabled: false,
  };
  billingChangeQuery.data = { kind: "none", enabled: true };
  setPricingQuery({ data: { plans: [] }, isFetching: true, isLoading: true });
  const { rerender } = renderWithMantine(<Billing />);
  expect(billingChangePrepare.mutateAsync).not.toHaveBeenCalled();
  expect(navigateSpy).not.toHaveBeenCalled();
  setPricingQuery({
    data: { plans: introPlans, annualIntroOffer },
    isFetching: false,
    isLoading: false,
  });
  await act(async () => {
    rerender(
      <MantineProvider>
        <Billing />
      </MantineProvider>,
    );
  });
  expect(billingChangePrepare.mutateAsync).toHaveBeenCalledWith({
    serverId: "g1",
    selection: {
      tier: "basic",
      interval: "year",
      expectedOffer: "basic_annual_intro_v1",
    },
  });
});

function setupRecovery(status: "grace" | "canceled") {
  authState.state = "authenticated";
  guildState.selectedGuildId = "g1";
  guildState.guilds = [{ id: "g1", name: "Guild One", canManage: true }];
  setRouteParams({ serverId: "g1" });
  setRouteSearch({ interval: "month" });
  const recovery = {
    status,
    priorTier: "pro" as const,
    selectedTier: "basic" as const,
    selectedInterval: "month" as const,
    scheduledChange: true,
    endsAt: new Date(Date.now() + 86400000).toISOString(),
    amountDue: 1000,
    currency: "usd",
    paymentUrl:
      status === "grace" ? "https://invoice.stripe.com/i/owned" : null,
    canManage: true,
  };
  setBillingQuery({
    data: {
      billingEnabled: true,
      tier: "pro",
      status: status === "grace" ? "past_due" : "canceled",
      stripeStatus: status === "grace" ? "past_due" : "canceled",
      billingSource: "stripe",
      hasStripeBilling: true,
      canManageBillingPortal: true,
      renewalRecovery: recovery,
    },
  });
  billingRenewalQuery.data = {
    state: { kind: "unavailable", knownEndsAt: null },
    canManageBilling: true,
    lifecycleAnalyticsEnabled: false,
  };
  billingChangeQuery.data = { kind: "none", enabled: false };
  setPricingQuery({ data: { plans: introPlans } });
  return recovery;
}
it("connects scheduled recovery without duplicate legacy renewal controls", () => {
  setupRecovery("grace");
  renderWithMantine(<Billing />);
  expect(screen.getByText(/scheduled change to Basic/)).toBeInTheDocument();
  expect(screen.getByText(/keep using Pro until/)).toBeInTheDocument();
  expect(screen.getByTestId("billing-current-plan")).not.toHaveTextContent(
    /renewal status|couldn't load|check status/i,
  );
  expect(
    screen.getAllByRole("button", { name: "Cancel renewal" }),
  ).toHaveLength(1);
});
it("permits another paid purchase during remaining canceled renewal grace", () => {
  setupRecovery("canceled");
  renderWithMantine(<Billing />);
  const basic = screen.getByTestId("billing-plan-basic");
  const pro = screen.getByTestId("billing-plan-pro");
  expect(
    within(basic).getByRole("button", { name: "Get Basic again" }),
  ).toBeEnabled();
  expect(
    within(pro).getByRole("button", { name: "Get Pro again" }),
  ).toBeEnabled();
  expect(within(pro).queryByText("Current plan")).not.toBeInTheDocument();
});
it("connects cancellation confirmation to the server-scoped recovery mutation", async () => {
  const recovery = setupRecovery("grace");
  billingRenewalCancelMutation.mutateAsync.mockResolvedValue({
    ...recovery,
    status: "canceled",
    paymentUrl: null,
  });
  renderWithMantine(<Billing />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel renewal" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Cancel this renewal?",
  });
  await act(async () => {
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel renewal" }),
    );
  });
  expect(billingRenewalCancelMutation.mutateAsync).toHaveBeenCalledWith({
    serverId: "g1",
  });
});
