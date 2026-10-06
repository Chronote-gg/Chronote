import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import UpgradeServerSelect from "./UpgradeServerSelect";

const mockSearch = jest.fn();
const mockBillingQuery = jest.fn();
const mockPricingQuery = jest.fn();
const mockGuild = jest.fn();
const mockAuth = jest.fn();
const mockNavigate = jest.fn();
const mockCheckout = jest.fn();
const mockPortal = jest.fn();
const mockPending = jest.fn();
const mockShowBillingError = jest.fn();
const mockTrack = jest.fn();
jest.mock("../services/analytics", () => ({
  track: (...args: unknown[]) => mockTrack(...args),
  isDoNotTrackEnabled: () => false,
}));
jest.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearch(),
  useNavigate: () => mockNavigate,
}));
jest.mock("../contexts/AuthContext", () => ({ useAuth: () => mockAuth() }));
jest.mock("../contexts/GuildContext", () => ({
  useGuildContext: () => mockGuild(),
}));
jest.mock("../utils/billingErrorNotification", () => ({
  showBillingError: (...args: unknown[]) => mockShowBillingError(...args),
}));
jest.mock("../services/trpc", () => ({
  trpc: {
    pricing: { plans: { useQuery: () => mockPricingQuery() } },
    billing: {
      me: { useQuery: (...args: unknown[]) => mockBillingQuery(...args) },
      checkout: {
        useMutation: () => ({
          mutateAsync: mockCheckout,
          isPending: mockPending(),
        }),
      },
      portal: {
        useMutation: () => ({ mutateAsync: mockPortal, isPending: false }),
      },
    },
  },
}));
const plans = [
  {
    tier: "basic",
    interval: "month",
    unitAmount: 1000,
    currency: "usd",
    priceId: "basic",
  },
  {
    tier: "pro",
    interval: "month",
    unitAmount: 2000,
    currency: "usd",
    priceId: "pro",
  },
  {
    tier: "pro",
    interval: "year",
    unitAmount: 20000,
    currency: "usd",
    priceId: "pro-year",
  },
];
const freeBilling = {
  tier: "free",
  billingEnabled: true,
  billingSource: "free",
  hasStripeBilling: false,
  canManageBillingPortal: false,
};
const guildState = {
  guilds: [
    { id: "s1", name: "Test server", canManage: true },
    { id: "s2", name: "New server", canManage: true },
    { id: "s3", name: "Member only", canManage: false },
  ],
  selectedGuildId: "s1",
  setSelectedGuildId: jest.fn(),
  loading: false,
  error: null,
  refresh: jest.fn(),
};
const renderSelector = () =>
  render(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
const button = (tier: string) =>
  screen.getByRole("button", { name: `Continue with ${tier}` });
beforeEach(() => {
  jest.clearAllMocks();
  mockSearch.mockReturnValue({});
  mockBillingQuery.mockReturnValue({
    data: freeBilling,
    isFetching: false,
    isError: false,
    refetch: jest.fn(),
  });
  mockPricingQuery.mockReturnValue({
    data: { plans },
    isError: false,
    refetch: jest.fn(),
  });
  mockGuild.mockReturnValue(guildState);
  mockAuth.mockReturnValue({ state: "authenticated", loading: false });
  mockPending.mockReturnValue(false);
  mockCheckout.mockRejectedValue(new Error("Controlled checkout stopped"));
});

it.each(["Basic", "Pro"])(
  "submits the clicked %s tier directly, regardless of URL tier",
  async (tier) => {
    mockSearch.mockReturnValue({
      plan: tier === "Basic" ? "pro" : "basic",
      serverId: "s1",
      promo: " SAVE20 ",
      canceled: true,
    });
    renderSelector();
    expect(
      screen.queryByRole("button", {
        name: /Select Basic|Select Pro|Continue to Stripe/,
      }),
    ).not.toBeInTheDocument();
    await userEvent.click(button(tier));
    expect(mockCheckout).toHaveBeenCalledTimes(1);
    expect(mockCheckout).toHaveBeenCalledWith({
      serverId: "s1",
      tier: tier.toLowerCase(),
      interval: "month",
      promotionCode: "SAVE20",
      source: "direct",
    });
    expect(mockNavigate).toHaveBeenCalledWith({
      replace: true,
      search: {
        plan: tier.toLowerCase(),
        serverId: "s1",
        promo: "SAVE20",
        canceled: undefined,
        interval: "month",
        source: "direct",
      },
    });
    expect(mockShowBillingError).toHaveBeenCalledWith(
      expect.any(Error),
      "checkout",
    );
    expect(mockPortal).not.toHaveBeenCalled();
  },
);

it("shows Free as a readonly comparison with vertical feature entries", () => {
  renderSelector();
  const free = within(screen.getByTestId("upgrade-plan-free"));
  expect(free.queryByRole("button")).not.toBeInTheDocument();
  expect(free.getAllByRole("listitem")).toHaveLength(3);
  expect(
    free.getByText("4 recording hours per rolling week"),
  ).toBeInTheDocument();
  expect(free.getByText("Ask across the last 5 meetings")).toBeInTheDocument();
  expect(screen.queryByTestId("upgrade-server-select")).not.toBeInTheDocument();
  expect(screen.getByText("Current plan: Free")).toBeInTheDocument();
});

it("records arrival/readiness once and retains only safe purchase properties", async () => {
  mockSearch.mockReturnValue({
    source: "discord_notes",
    serverId: "s1",
    promo: "PRIVATE-PROMO",
  });
  const view = renderSelector();
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expect(
    mockTrack.mock.calls.filter(([event]) => event === "upgrade_arrived"),
  ).toHaveLength(1);
  expect(
    mockTrack.mock.calls.filter(([event]) => event === "upgrade_ready"),
  ).toHaveLength(1);
  await userEvent.click(button("Pro"));
  expect(mockTrack).toHaveBeenCalledWith("upgrade_plan_clicked", {
    guild_id: "s1",
    tier: "pro",
    interval: "month",
    source: "discord_notes",
    promo_present: true,
    event_version: 1,
  });
  expect(JSON.stringify(mockTrack.mock.calls)).not.toContain("PRIVATE-PROMO");
});

it("reports a changed billing block without reporting readiness", () => {
  mockBillingQuery.mockReturnValue({ isError: true, isFetching: false });
  const view = renderSelector();
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expect(
    mockTrack.mock.calls.filter(([event]) => event === "upgrade_blocked"),
  ).toHaveLength(1);
  expect(mockTrack).toHaveBeenCalledWith(
    "upgrade_blocked",
    expect.objectContaining({ reason: "billing_failed" }),
  );
  expect(
    mockTrack.mock.calls.some(([event]) => event === "upgrade_ready"),
  ).toBe(false);
});

it("preserves annual intent and refuses a missing annual Basic price", async () => {
  mockSearch.mockReturnValue({
    interval: "year",
    plan: "basic",
    promo: " SAVE20 ",
  });
  renderSelector();
  expect(button("Basic")).toBeDisabled();
  expect(screen.getByText("Pricing unavailable")).toBeInTheDocument();
  await userEvent.click(button("Pro"));
  expect(mockCheckout).toHaveBeenCalledWith({
    serverId: "s1",
    tier: "pro",
    interval: "year",
    promotionCode: "SAVE20",
    source: "direct",
  });
  expect(screen.getByText("$200 / yr")).toBeInTheDocument();
  expect(screen.queryByText(/2 months free/)).not.toBeInTheDocument();
});

it.each(["unavailable", "s3"])(
  "keeps unavailable/unmanageable server %s intent and offers recovery",
  (serverId) => {
    mockSearch.mockReturnValue({ serverId, plan: "pro" });
    renderSelector();
    expect(screen.getByText("That server is unavailable")).toBeInTheDocument();
    expect(button("Basic")).toBeDisabled();
    expect(button("Pro")).toBeDisabled();
    expect(mockBillingQuery).toHaveBeenCalledWith(
      { serverId },
      expect.objectContaining({ enabled: false }),
    );
    expect(guildState.setSelectedGuildId).not.toHaveBeenCalled();
  },
);

it("requires explicit server selection when none is saved", () => {
  mockGuild.mockReturnValue({ ...guildState, selectedGuildId: null });
  renderSelector();
  expect(screen.getByText("Choose your server")).toBeInTheDocument();
  expect(button("Basic")).toBeDisabled();
});

it("preserves tier, interval, promo and cancellation through login", () => {
  mockAuth.mockReturnValue({ state: "unauthenticated", loading: false });
  mockSearch.mockReturnValue({
    serverId: "s1",
    plan: "pro",
    interval: "year",
    promo: " SAVE20 ",
    canceled: true,
  });
  renderSelector();
  const login = new URL(
    screen.getByRole("link", { name: "Connect Discord" }).getAttribute("href")!,
    window.location.origin,
  );
  const redirect = new URL(login.searchParams.get("redirect")!);
  expect(redirect.pathname).toBe("/upgrade/select-server");
  expect(Object.fromEntries(redirect.searchParams)).toEqual({
    serverId: "s1",
    plan: "pro",
    interval: "year",
    promo: "SAVE20",
    canceled: "true",
    source: "direct",
  });
  expect(button("Pro")).toBeDisabled();
  expect(mockCheckout).not.toHaveBeenCalled();
});

it.each(["fetching", "error", "missing", "disabled"])(
  "blocks purchase while billing is %s",
  (state) => {
    mockBillingQuery.mockReturnValue({
      data:
        state === "missing"
          ? undefined
          : { ...freeBilling, billingEnabled: state !== "disabled" },
      isFetching: state === "fetching",
      isError: state === "error",
      refetch: jest.fn(),
    });
    renderSelector();
    expect(button("Basic")).toBeDisabled();
    expect(button("Pro")).toBeDisabled();
    if (state === "error")
      expect(
        screen.getByRole("button", { name: "Retry billing" }),
      ).toBeVisible();
  },
);

it("blocks stale billing data after switching servers until refreshed", () => {
  mockSearch.mockReturnValue({ serverId: "s1" });
  const view = renderSelector();
  mockSearch.mockReturnValue({ serverId: "s2", plan: "pro" });
  mockBillingQuery.mockReturnValue({ data: freeBilling, isFetching: true });
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expect(screen.getByText("New server")).toBeInTheDocument();
  expect(button("Pro")).toBeDisabled();
  mockBillingQuery.mockReturnValue({ data: freeBilling, isFetching: false });
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expect(button("Pro")).toBeEnabled();
});

it("blocks both actions during checkout and while changing the server", async () => {
  const view = renderSelector();
  await userEvent.click(screen.getByRole("button", { name: "Change server" }));
  expect(button("Basic")).toBeDisabled();
  expect(button("Pro")).toBeDisabled();
  await userEvent.click(
    screen.getByRole("button", { name: "Keep this server" }),
  );
  mockPending.mockReturnValue(true);
  view.rerender(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );
  expect(button("Basic")).toBeDisabled();
  expect(button("Pro")).toBeDisabled();
});

it("keeps Basic subscriptions on the guarded Pro path", async () => {
  mockBillingQuery.mockReturnValue({
    data: {
      ...freeBilling,
      tier: "basic",
      billingSource: "stripe",
      hasStripeBilling: true,
      canManageBillingPortal: true,
    },
  });
  renderSelector();
  expect(screen.getByRole("button", { name: "Current plan" })).toBeDisabled();
  await userEvent.click(button("Pro"));
  expect(mockCheckout).toHaveBeenCalledWith(
    expect.objectContaining({ tier: "pro" }),
  );
  expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
});

it.each([
  {
    ...freeBilling,
    tier: "pro",
    billingSource: "stripe",
    hasStripeBilling: true,
    canManageBillingPortal: true,
  },
  {
    ...freeBilling,
    tier: "free",
    hasStripeBilling: true,
    canManageBillingPortal: true,
  },
  { ...freeBilling, tier: "basic", billingSource: "forced" },
])(
  "uses management for Pro, existing billing pointers, or environment overrides",
  (data) => {
    mockBillingQuery.mockReturnValue({ data });
    renderSelector();
    expect(button("Pro")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Open server billing" }),
    ).toBeEnabled();
  },
);

it.each(["basic", "pro"])(
  "allows a complimentary %s server to start paying without calling it Free",
  (tier) => {
    mockBillingQuery.mockReturnValue({
      data: { ...freeBilling, tier, billingSource: "manual_comp" },
    });
    renderSelector();
    expect(
      screen.getByText(new RegExp("Current plan: .*complimentary")),
    ).toBeInTheDocument();
    expect(button("Pro")).toBeEnabled();
    if (tier === "basic") expect(button("Basic")).toBeEnabled();
  },
);

it("shows discovery and pricing recovery without enabling purchases", () => {
  mockGuild.mockReturnValue({
    ...guildState,
    error: "Servers could not be loaded",
  });
  mockPricingQuery.mockReturnValue({ isError: true, refetch: jest.fn() });
  renderSelector();
  expect(screen.getByRole("button", { name: "Retry servers" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry pricing" })).toBeVisible();
  expect(button("Basic")).toBeDisabled();
  expect(button("Pro")).toBeDisabled();
});
