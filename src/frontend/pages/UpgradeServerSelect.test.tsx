import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MantineProvider } from "@mantine/core";
import UpgradeServerSelect from "./UpgradeServerSelect";

const mockSearch = jest.fn();
const mockBilling = jest.fn();
const mockNavigate = jest.fn();
const mockCheckout = jest.fn();
const mockPortal = jest.fn();
const mockShowBillingError = jest.fn();
jest.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearch(),
  useNavigate: () => mockNavigate,
}));
jest.mock("../contexts/AuthContext", () => ({
  useAuth: () => ({ state: "authenticated", loading: false }),
}));
jest.mock("../contexts/GuildContext", () => ({
  useGuildContext: () => ({
    guilds: [
      { id: "s1", name: "Test server", canManage: true },
      { id: "s2", name: "New server", canManage: true },
    ],
    selectedGuildId: "s1",
    setSelectedGuildId: jest.fn(),
    loading: false,
  }),
}));
jest.mock("../utils/billingErrorNotification", () => ({
  showBillingError: (...args: unknown[]) => mockShowBillingError(...args),
}));
jest.mock("../services/trpc", () => ({
  trpc: {
    pricing: {
      plans: {
        useQuery: () => ({
          data: {
            plans: [
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
            ],
          },
        }),
      },
    },
    billing: {
      me: { useQuery: () => ({ data: mockBilling(), isLoading: false }) },
      checkout: {
        useMutation: () => ({ mutateAsync: mockCheckout, isPending: false }),
      },
      portal: {
        useMutation: () => ({ mutateAsync: mockPortal, isPending: false }),
      },
    },
  },
}));

const renderSelector = () =>
  render(
    <MantineProvider>
      <UpgradeServerSelect />
    </MantineProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch.mockReturnValue({});
  mockBilling.mockReturnValue({ tier: "free", billingEnabled: true });
});

it("defaults a new buyer to Basic and recommends that card", () => {
  renderSelector();
  expect(
    screen.getByRole("button", { name: "Continue to Stripe (Basic)" }),
  ).toBeEnabled();
  const basicCard = screen
    .getByRole("heading", { name: "Basic" })
    .closest(".mantine-Paper-root")!;
  expect(
    within(basicCard as HTMLElement).getByText("Recommended"),
  ).toBeInTheDocument();
});

it("preserves an explicit Pro annual selection and trimmed promotion in the checkout request", async () => {
  mockSearch.mockReturnValue({
    plan: "pro",
    interval: "year",
    promo: " SAVE20 ",
    serverId: "s1",
    canceled: true,
  });
  const failure = new Error("Subscription changes are unavailable");
  mockCheckout.mockRejectedValueOnce(failure);
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    renderSelector();
    await userEvent.click(
      screen.getByRole("button", { name: "Continue to Stripe (Pro)" }),
    );
    expect(mockCheckout).toHaveBeenCalledTimes(1);
    expect(mockCheckout).toHaveBeenCalledWith({
      serverId: "s1",
      tier: "pro",
      interval: "year",
      promotionCode: "SAVE20",
    });
    expect(mockShowBillingError).toHaveBeenCalledWith(failure, "checkout");
    expect(mockPortal).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

it("keeps Basic subscribers on the existing Pro upgrade path", () => {
  mockSearch.mockReturnValue({ plan: "basic" });
  mockBilling.mockReturnValue({ tier: "basic", billingEnabled: true });
  renderSelector();
  expect(screen.getByRole("button", { name: "Current plan" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Continue to Stripe (Pro)" }),
  ).toBeEnabled();
  expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
});

it("offers existing Pro subscribers management rather than checkout", () => {
  mockBilling.mockReturnValue({ tier: "pro", billingEnabled: true });
  renderSelector();
  expect(screen.getByRole("button", { name: "Manage billing" })).toBeEnabled();
  expect(
    screen.queryByRole("button", { name: /Continue to Stripe/ }),
  ).not.toBeInTheDocument();
});

it.each(["basic", "pro"])(
  "preserves selection when switching a %s guild to a Free guild, then checks out the newly chosen Basic plan for that guild",
  async (tier) => {
    mockSearch.mockReturnValue({ serverId: "s1" });
    mockBilling.mockReturnValue({ tier, billingEnabled: true });
    const view = renderSelector();

    mockSearch.mockReturnValue({ serverId: "s2" });
    mockBilling.mockReturnValue({ tier: "free", billingEnabled: true });
    view.rerender(
      <MantineProvider>
        <UpgradeServerSelect />
      </MantineProvider>,
    );
    expect(
      screen.getByRole("button", { name: "Continue to Stripe (Pro)" }),
    ).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Select Basic" }));
    expect(
      screen.getByRole("button", { name: "Continue to Stripe (Basic)" }),
    ).toBeEnabled();

    mockCheckout.mockRejectedValueOnce(new Error("Preview checkout stopped"));
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Continue to Stripe (Basic)" }),
      );
      expect(mockCheckout).toHaveBeenCalledWith({
        serverId: "s2",
        tier: "basic",
        interval: "month",
        promotionCode: undefined,
      });
    } finally {
      log.mockRestore();
    }
  },
);

it("preserves other query fields when the buyer explicitly changes plans", async () => {
  renderSelector();
  await userEvent.click(screen.getByRole("button", { name: "Select Pro" }));
  const update = mockNavigate.mock.calls.at(-1)[0].search;
  expect(
    update({
      serverId: "s1",
      promo: "SAVE20",
      interval: "year",
      canceled: true,
    }),
  ).toEqual({
    serverId: "s1",
    promo: "SAVE20",
    interval: "year",
    canceled: true,
    plan: "pro",
  });
  expect(
    screen.getByRole("button", { name: "Continue to Stripe (Pro)" }),
  ).toBeEnabled();
});
