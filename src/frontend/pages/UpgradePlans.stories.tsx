import type { RenewalRecoveryView } from "../../types/renewalRecovery";
import { renewalGraceFixture } from "./renewalGraceFixtures";
import type { BillingChangeView } from "../../types/billingChange";
import { previewChangeReview } from "./billingChangeFixtures";
import type { RenewalView } from "../../types/renewal";
import { createRenewalFixture } from "./renewalFixtures";
import type { TerminalSubscriptionStatus } from "../utils/billingManagement";
import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { useMantineColorScheme } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { QueryClient } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { trpc } from "../services/trpc";
import { AuthenticatedPreviewProviders } from "../storybook/AuthenticatedPreviewProviders";
import Upgrade from "./Upgrade";
import UpgradeServerSelect from "./UpgradeServerSelect";
import Billing from "./Billing";
import Join from "./Join";
import PromoLanding from "./PromoLanding";
import Home from "./Home";
import type {
  BasicIntroOffer,
  ProviderSubscriptionDetails,
} from "../../types/pricing";
import {
  introPlans,
  monthlyIntroOffer,
  annualIntroOffer,
  monthlySubscriber,
  annualSubscriber,
} from "./basicIntroFixtures";

function previewSubscriptionStatus(
  tier: "free" | "basic" | "pro",
  source: "free" | "stripe" | "manual_comp" | "forced",
  terminalStatus?: TerminalSubscriptionStatus,
) {
  if (source === "manual_comp") return "comped";
  if (terminalStatus) return terminalStatus;
  return tier === "free" ? "free" : "active";
}
function previewStripeStatus(
  source: "free" | "stripe" | "manual_comp" | "forced",
  terminalStatus?: TerminalSubscriptionStatus,
) {
  return terminalStatus ?? (source === "stripe" ? "active" : null);
}
function previewBilling(
  tier: "free" | "basic" | "pro",
  billingSource?: "free" | "stripe" | "manual_comp" | "forced",
  terminalStatus?: TerminalSubscriptionStatus,
) {
  const source = billingSource ?? (tier === "free" ? "free" : "stripe");
  return {
    tier,
    status: previewSubscriptionStatus(tier, source, terminalStatus),
    stripeStatus: previewStripeStatus(source, terminalStatus),
    billingSource: source,
    stripeTier: source === "stripe" && tier !== "free" ? tier : null,
    grantTier: source === "manual_comp" ? tier : null,
    activeGrant: null,
    nextBillingDate: null,
    stripeCustomerId: null,
    hasStripeBilling: Boolean(terminalStatus || source === "stripe"),
    canManageBillingPortal: Boolean(terminalStatus || source === "stripe"),
    upgradeUrl: null,
    portalUrl: null,
    billingEnabled: true,
    stripeMode: "test",
    usage: {
      usedMinutes: 45,
      limitMinutes: tier === "pro" ? null : tier === "basic" ? 1200 : 240,
      remainingMinutes: tier === "pro" ? null : tier === "basic" ? 1155 : 195,
    },
  };
}

type UpgradePreviewProps = {
  recovery?: RenewalRecoveryView;
  change?: BillingChangeView;
  width?: number;
  renewal?: RenewalView;
  path?: string;
  tier?: "free" | "basic" | "pro";
  colorScheme?: "light" | "dark";
  signedIn?: boolean;
  errorFor?: "billing.me" | "pricing.plans" | "servers.listEligible";
  billingSource?: "free" | "stripe" | "manual_comp" | "forced";
  introStatus?: BasicIntroOffer["status"];
  subscriptionDetails?: ProviderSubscriptionDetails;
  cancellationAt?: string | null;
  loadingBilling?: boolean;
  staleQuote?: boolean;
  pendingCheckout?: boolean;
  paymentSettling?: boolean;
  missingPrices?: boolean;
  terminalStatus?: TerminalSubscriptionStatus;
};

function previewIntroOffers(status: BasicIntroOffer["status"]) {
  return {
    introOffer: status === "available" ? monthlyIntroOffer : { status },
    annualIntroOffer: status === "available" ? annualIntroOffer : { status },
  };
}

function previewResponses({
  tier = "free",
  signedIn = true,
  billingSource,
  terminalStatus,
  subscriptionDetails,
  cancellationAt,
  paymentSettling,
  introStatus,
  staleQuote,
  missingPrices,
  renewal,
}: UpgradePreviewProps): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "auth.me": signedIn
      ? {
          id: "story-user",
          username: "Preview",
          avatar: null,
        }
      : null,
    "servers.listEligible": {
      guilds: [{ id: "example", name: "Engineering HQ", canManage: true }],
    },
    "pricing.plans": {
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
          unitAmount: 2000,
          currency: "usd",
        },
        {
          tier: "basic",
          interval: "year",
          priceId: "basic-year",
          unitAmount: 10000,
          currency: "usd",
        },
        {
          tier: "pro",
          interval: "year",
          priceId: "pro-year",
          unitAmount: 20000,
          currency: "usd",
        },
      ],
    },
    "billing.change": { kind: "none", enabled: false },
    "billing.renewal":
      renewal ??
      createRenewalFixture({
        details: subscriptionDetails,
        cancellationAt,
        terminalStatus,
      }),
    "billing.me": {
      ...previewBilling(tier, billingSource, terminalStatus),
      ...(paymentSettling
        ? { status: "incomplete", stripeStatus: "incomplete" }
        : {}),
      subscriptionDetails,
      cancellationAt: cancellationAt ?? null,
      ...previewIntroOffers(introStatus ?? "inactive"),
    },
  };
  if (introStatus)
    data["pricing.plans"] = {
      plans: introPlans,
      ...previewIntroOffers(introStatus),
    };
  if (staleQuote)
    data["billing.me"] = {
      ...previewBilling(tier, billingSource, terminalStatus),
      ...(paymentSettling
        ? { status: "incomplete", stripeStatus: "incomplete" }
        : {}),
      introOffer: { ...monthlyIntroOffer, priceId: "stale-price" },
      annualIntroOffer: {
        ...annualIntroOffer,
        priceId: "stale-price",
      },
    };
  if (missingPrices) data["pricing.plans"] = { plans: [] };
  return data;
}

export function UpgradePreview({
  path = "/upgrade/select-server?serverId=example",
  tier = "free",
  colorScheme = "dark",
  signedIn = true,
  errorFor,
  billingSource,
  introStatus,
  subscriptionDetails,
  cancellationAt,
  loadingBilling = false,
  staleQuote = false,
  pendingCheckout = false,
  paymentSettling = false,
  missingPrices = false,
  terminalStatus,
  renewal,
  change,
  recovery,
  width,
}: UpgradePreviewProps) {
  const { setColorScheme } = useMantineColorScheme();
  useEffect(() => notifications.clean(), []);
  useEffect(() => setColorScheme(colorScheme), [colorScheme, setColorScheme]);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false },
          mutations: { retry: false },
        },
      }),
  );
  const [client] = useState(() => {
    let currentRecovery = recovery ?? { status: "none" as const };
    let currentChange: BillingChangeView = change ?? {
      kind: "none",
      enabled: false,
    };
    let currentRenewal =
      renewal ??
      createRenewalFixture({
        details: subscriptionDetails,
        cancellationAt,
        terminalStatus,
      });
    function respondToRecovery(url: string, data: Record<string, unknown>) {
      if (currentRecovery.status !== "none") {
        if (url.includes("billing.cancelRenewalPayment")) {
          currentRecovery = {
            ...currentRecovery,
            status: "canceled",
            paymentUrl: null,
          };
          data["billing.cancelRenewalPayment"] = currentRecovery;
        }
        data["billing.me"] = {
          ...previewBilling(
            tier,
            billingSource,
            currentRecovery.status === "canceled" ? "canceled" : undefined,
          ),
          status:
            currentRecovery.status === "canceled" ? "canceled" : "past_due",
          stripeStatus:
            currentRecovery.status === "canceled" ? "canceled" : "past_due",
          renewalRecovery: currentRecovery,
        };
        data["pricing.plans"] = {
          plans: introPlans,
          ...previewIntroOffers("inactive"),
        };
      }
    }
    function respondToPlanChange(
      paths: string[],
      body: RequestInit["body"],
      data: Record<string, unknown>,
    ) {
      if (paths.includes("billing.prepareChange")) {
        const request = JSON.parse(String(body ?? "{}"));
        const input = request["0"]?.json ?? request["0"];
        currentChange = previewChangeReview(input.selection);
        data["billing.prepareChange"] = currentChange;
      }
      if (
        paths.includes("billing.confirmChange") &&
        currentChange.kind === "operation"
      ) {
        currentChange = {
          ...currentChange,
          state:
            currentChange.quote.timing === "renewal" ? "scheduled" : "accepted",
          revision: "confirmed",
          paymentUrl:
            currentChange.quote.timing === "renewal"
              ? null
              : "https://example.invalid/preview-payment",
        };
        data["billing.confirmChange"] = currentChange;
      }
      if (
        paths.includes("billing.cancelChange") &&
        currentChange.kind === "operation"
      ) {
        data["billing.cancelChange"] = {
          ...currentChange,
          state: "canceled",
        };
        currentChange = { kind: "none", enabled: true };
      }
    }
    function respondToRenewal(paths: string[], data: Record<string, unknown>) {
      if (paths.includes("billing.reactivateRenewal")) {
        const state = currentRenewal.state;
        if (state.kind === "off" && state.action.kind === "ready") {
          const terms = state.action.terms;
          currentRenewal = {
            ...currentRenewal,
            state: { kind: "on", terms },
          };
          data["billing.reactivateRenewal"] = {
            kind: "confirmed",
            terms,
          };
        } else data["billing.reactivateRenewal"] = { kind: "changed" };
      }
    }
    return trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async (url, options) => {
            const data = previewResponses({
              tier,
              signedIn,
              billingSource,
              terminalStatus,
              subscriptionDetails,
              cancellationAt,
              paymentSettling,
              introStatus,
              staleQuote,
              missingPrices,
              renewal: currentRenewal,
            });
            data["billing.change"] = currentChange;
            respondToRecovery(String(url), data);
            const paths = new URL(String(url), window.location.origin).pathname
              .split("/")
              .at(-1)!
              .split(",");
            respondToPlanChange(paths, options?.body, data);
            respondToRenewal(paths, data);
            if (errorFor && paths.includes(errorFor))
              throw new Error("Preview request failed");
            if (loadingBilling && paths.includes("billing.me"))
              await new Promise(() => {});
            if (pendingCheckout && paths.includes("billing.checkout"))
              await new Promise(() => {});
            // Story requests never reach a server, and purchase actions are deliberately refused.
            if (paths.some((name) => !(name in data)))
              throw new Error("Preview only: billing actions are disabled");
            return new Response(
              JSON.stringify(
                paths.map((name) => ({ result: { data: data[name] } })),
              ),
              { headers: { "Content-Type": "application/json" } },
            );
          },
        }),
      ],
    });
  });
  const [router] = useState(() => {
    localStorage.setItem("mn-selected-guild", "example");
    const root = createRootRoute({ component: Outlet });
    const routes = [
      createRoute({ getParentRoute: () => root, path: "/", component: Home }),
      createRoute({
        getParentRoute: () => root,
        path: "/promo/$code",
        component: PromoLanding,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/join",
        component: Join,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/upgrade",
        component: Upgrade,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/upgrade/select-server",
        component: UpgradeServerSelect,
        validateSearch: (search) => search,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/portal/server/$serverId/billing",
        component: Billing,
        validateSearch: (search) => search,
      }),
    ];
    return createRouter({
      routeTree: root.addChildren(routes),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
  });
  return (
    <AuthenticatedPreviewProviders client={client} queryClient={queryClient}>
      <div
        style={{
          padding: 16,
          maxWidth: width ?? 1100,
          marginInline: "auto",
          background: "var(--mantine-color-body)",
          minHeight: "100vh",
        }}
      >
        <RouterProvider router={router} />
      </div>
    </AuthenticatedPreviewProviders>
  );
}

const meta = {
  title: "Pages/UpgradePlans",
  tags: ["upgrade-plans"],
  component: UpgradePreview,
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PromoPrivacy: Story = {
  args: { path: "/promo/SAVE20" },
  play: async ({ canvasElement }) => {
    const code = await within(canvasElement).findByText("SAVE20");
    await expect(code).toHaveClass("ph-no-capture", "ph-mask");
  },
};
export const NewBuyer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Continue with Basic" }),
      ).toBeEnabled(),
    );
    await expect(canvas.getByText("Recommended")).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Monthly" })).toBeChecked();
    await expect(canvas.queryByText(/months free/)).toBeNull();
  },
};
export const NewBuyerLight: Story = {
  ...NewBuyer,
  args: { colorScheme: "light" },
};
export const SignedOutUpgradeLink: Story = {
  args: {
    signedIn: false,
    path: "/upgrade/select-server?serverId=example&plan=basic",
  },
  play: async ({ canvasElement }) => {
    const connect = await within(canvasElement).findByRole("link", {
      name: "Connect Discord",
    });
    await expect(connect).toBeVisible();
    const redirect = new URL(
      connect.getAttribute("href")!,
      window.location.origin,
    ).searchParams.get("redirect");
    const returnUrl = new URL(redirect!);
    await expect(returnUrl.pathname).toBe("/upgrade/select-server");
    await expect(returnUrl.searchParams.get("serverId")).toBe("example");
    await expect(returnUrl.searchParams.get("plan")).toBe("basic");
  },
};
export const UnavailableServerUpgradeLink: Story = {
  args: { path: "/upgrade/select-server?serverId=unavailable&plan=basic" },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("button", {
        name: "Select server",
      }),
    ).toBeVisible();
  },
};
export const NewBuyerNarrow: Story = {
  play: async ({ canvasElement }) => {
    const button = await within(canvasElement).findByRole("button", {
      name: "Continue with Basic",
    });
    // Exercise the mobile-sized CTA without pretending a narrow container
    // changes viewport-based grid breakpoints.
    button.style.width = "250px";
    const label = button.querySelector(".mantine-Button-label")!;
    await expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  },
};
export const ExplicitProAnnual: Story = {
  args: {
    path: "/upgrade/select-server?serverId=example&plan=pro&interval=year&promo=SAVE20",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("$100 / yr")).toBeVisible();
    await expect(canvas.getAllByText("Billed yearly")[0]).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: "Monthly" }));
    await expect(await canvas.findByText("$10 / mo")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: /Annual/ }));
    await expect(await canvas.findByText("$100 / yr")).toBeVisible();
  },
};
export const ExistingBasic: Story = { args: { tier: "basic" } };
export const ExistingPro: Story = { args: { tier: "pro" } };
export const Complimentary: Story = {
  tags: ["billing-comp-pricing"],
  args: { tier: "basic", billingSource: "manual_comp" },
};
export const BillingCompedKnownPrice: Story = {
  tags: ["billing-comp-pricing"],
  args: {
    tier: "basic",
    billingSource: "manual_comp",
    introStatus: "ineligible",
    colorScheme: "light",
    path: "/portal/server/example/billing",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/This is normally \$10 \/ mo\./),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Start paying for Basic" }),
    ).toBeEnabled();
    await expect(
      canvas.queryByRole("button", { name: "Manage billing" }),
    ).toBeNull();
  },
};
export const BillingCompedMissingPrice: Story = {
  ...BillingCompedKnownPrice,
  tags: ["billing-comp-pricing"],
  args: {
    ...BillingCompedKnownPrice.args,
    missingPrices: true,
    colorScheme: "dark",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/Regular pricing is unavailable right now\./),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Start paying for Basic" }),
    ).toBeDisabled();
    await expect(
      canvas.queryByRole("button", { name: "Manage billing" }),
    ).toBeNull();
  },
};
export const BillingUnavailable: Story = { args: { errorFor: "billing.me" } };
export const PricingUnavailable: Story = {
  args: { errorFor: "pricing.plans" },
};
export const DiscoveryUnavailable: Story = {
  args: { errorFor: "servers.listEligible" },
};
export const Landing: Story = { args: { path: "/upgrade" } };
export const BillingFree: Story = {
  args: { path: "/portal/server/example/billing" },
};
export const BillingCanceledSubscription: Story = {
  tags: ["integration-terminal-history"],
  args: { path: "/portal/server/example/billing", terminalStatus: "canceled" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const currentPlan = await canvas.findByTestId("billing-current-plan");
    await expect(currentPlan).toHaveTextContent("Free");
    await expect(currentPlan).not.toHaveTextContent("Canceled");
    await expect(currentPlan).not.toHaveTextContent("No subscription needed");
    await expect(
      canvas.getByRole("button", { name: "Get Basic again" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Upgrade to Pro" }),
    ).toBeEnabled();
    const history = canvas.getByTestId("billing-payment-history");
    await userEvent.click(
      within(history).getByRole("button", { name: "Payment history" }),
    );
    await expect(history).toHaveTextContent("Previous subscription: Canceled");
    await expect(
      within(history).getByRole("button", {
        name: "View invoices and receipts",
      }),
    ).toBeEnabled();
  },
};

export const BillingCanceledWithIntro: Story = {
  ...BillingCanceledSubscription,
  tags: ["integration-terminal-history"],
  args: { ...BillingCanceledSubscription.args, introStatus: "available" },
  play: async (context) => {
    await BillingCanceledSubscription.play?.(context);
    const canvas = within(context.canvasElement);
    await expect(canvas.getByTestId("basic-intro-terms")).toHaveTextContent(
      "$6/month",
    );
    await userEvent.click(
      within(canvas.getByTestId("billing-interval")).getByText("Annual", {
        exact: true,
      }),
    );
    await expect(canvas.getByTestId("basic-intro-terms")).toHaveTextContent(
      "$60",
    );
  },
};
export const BillingCanceledOfferUnavailable: Story = {
  ...BillingCanceledSubscription,
  tags: ["integration-terminal-history"],
  args: { ...BillingCanceledSubscription.args, introStatus: "unavailable" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByTestId("billing-current-plan"),
    ).toHaveTextContent("Free");
    await expect(
      canvas.getByTestId("billing-current-plan"),
    ).not.toHaveTextContent("Canceled");
    await userEvent.click(
      canvas.getByRole("button", { name: "Payment history", exact: true }),
    );
    await expect(
      canvas.getByTestId("billing-payment-history"),
    ).toHaveTextContent("Previous subscription: Canceled");
    await expect(
      canvas.getByRole("button", { name: "Get Basic again" }),
    ).toBeDisabled();
    await expect(
      canvas.getByRole("button", { name: "Upgrade to Pro" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "View invoices and receipts" }),
    ).toBeEnabled();
  },
};

export const BillingPaid: Story = {
  args: { path: "/portal/server/example/billing", tier: "basic" },
};

export const WeeklyLimit: Story = {
  args: {
    path: "/upgrade/select-server?serverId=example&plan=basic&source=discord_limit&limitType=weekly_recording&limitSurface=manual_start",
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Compare weekly recording time for this server.",
      ),
    ).toBeVisible();
  },
};
export const DurationLimitSignedOut: Story = {
  args: {
    signedIn: false,
    path: "/upgrade/select-server?serverId=example&plan=basic&source=discord_limit&limitType=meeting_duration&limitSurface=duration_stop",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/No plan allows a meeting longer than two hours/),
    ).toBeVisible();
    const href = canvas
      .getByRole("link", { name: "Connect Discord" })
      .getAttribute("href")!;
    const redirect = new URL(href, window.location.origin).searchParams.get(
      "redirect",
    )!;
    await expect(new URL(redirect).searchParams.get("limitSurface")).toBe(
      "duration_stop",
    );
  },
};
export const BillingLimit: Story = {
  args: {
    tier: "basic",
    path: "/portal/server/example/billing?source=discord_limit&limitType=weekly_recording&limitSurface=weekly_after_meeting",
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText(
        "Compare weekly recording time for this server.",
      ),
    ).toBeVisible();
  },
};

export const LegacyBillingLimit: Story = {
  args: {
    tier: "free",
    billingSource: "stripe",
    path: "/portal/server/example/billing?source=discord_limit&limitType=weekly_recording&limitSurface=manual_start",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Manage billing" }),
    ).toBeVisible();
    await expect(
      within(canvas.getByTestId("billing-current-plan")).getByText("Free", {
        exact: true,
        selector: "p[data-size=lg]",
      }),
    ).toBeVisible();
  },
};

async function expectAccountTerms(
  canvasElement: HTMLElement,
  interval: "month" | "year",
) {
  const canvas = within(canvasElement);
  const terms = await canvas.findByTestId("basic-intro-terms");
  await expect(terms).toHaveTextContent(
    "Each offer is available once per server. Cannot combine with other offers. Auto-renews. Tax may apply.",
  );
  await expect(terms).not.toHaveTextContent("account-wide plan changes");
  await expect(terms).toHaveTextContent(
    interval === "month"
      ? "$6/month for your first 3 months"
      : "$60 for your first year",
  );
  await expect(canvas.getByLabelText("Regular price")).toHaveStyle({
    "text-decoration-line": "line-through",
  });
}

const saleTags = ["basic-intro"];
export const IntroMonthly: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  args: { introStatus: "available" },
  play: async ({ canvasElement }) => expectAccountTerms(canvasElement, "month"),
};
export const IntroMonthlyLight: Story = {
  ...IntroMonthly,
  args: { ...IntroMonthly.args, colorScheme: "light" },
};
export const IntroAnnual: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  args: {
    introStatus: "available",
    path: "/upgrade/select-server?serverId=example&interval=year",
  },
  play: async ({ canvasElement }) => expectAccountTerms(canvasElement, "year"),
};
export const IntroProAnnual: Story = {
  ...IntroAnnual,
  args: {
    ...IntroAnnual.args,
    path: "/upgrade/select-server?serverId=example&plan=pro&interval=year",
  },
};
export const IntroLoading: Story = {
  tags: saleTags,
  args: { introStatus: "available", loadingBilling: true },
};
export const IntroUnavailable: Story = {
  tags: saleTags,
  args: { introStatus: "unavailable" },
};
export const IntroStaleQuote: Story = {
  tags: saleTags,
  args: { introStatus: "available", staleQuote: true },
};
export const IntroFrozenRetry: Story = {
  tags: saleTags,
  args: {
    introStatus: "available",
    path: "/upgrade/select-server?serverId=example&promo=SAVE20",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Continue with Basic" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Continue with Basic" }),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Retry checkout" }),
      ).toBeEnabled(),
    );
  },
};
export const IntroCheckoutPending: Story = {
  ...IntroFrozenRetry,
  args: { ...IntroFrozenRetry.args, pendingCheckout: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const basic = await canvas.findByRole("button", {
      name: "Continue with Basic",
    });
    await waitFor(() => expect(basic).toBeEnabled());
    await userEvent.click(basic);
    await waitFor(() => expect(basic).toBeDisabled());
    await expect(
      canvas.getByRole("button", { name: "Continue with Pro" }),
    ).toBeDisabled();
  },
};
export const IntroExpired: Story = {
  tags: saleTags,
  args: { introStatus: "expired" },
};
export const IntroInactive: Story = {
  tags: saleTags,
  args: { introStatus: "inactive" },
};
export const IntroIneligible: Story = {
  tags: saleTags,
  args: { introStatus: "ineligible", tier: "basic" },
};
export const IntroLegacy: Story = {
  tags: saleTags,
  args: { introStatus: "ineligible", billingSource: "stripe" },
};
export const IntroPromotionConflict: Story = {
  tags: saleTags,
  args: {
    introStatus: "available",
    path: "/upgrade/select-server?serverId=example&promo=SAVE20",
  },
};
export const IntroPromotionChosen: Story = {
  tags: saleTags,
  args: {
    introStatus: "available",
    path: "/upgrade/select-server?serverId=example&promo=SAVE20&offerChoice=promotion",
  },
};
export const IntroHome: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  args: { introStatus: "available", path: "/" },
  play: async ({ canvasElement }) => expectAccountTerms(canvasElement, "month"),
};
export const IntroHomeAnnual: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  ...IntroHome,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByText("Annual"));
    await expect(await canvas.findByText("$60 / yr")).toBeVisible();
    await expectAccountTerms(canvasElement, "year");
  },
};
export const IntroBillingFree: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  args: { introStatus: "available", path: "/portal/server/example/billing" },
  play: async ({ canvasElement }) => expectAccountTerms(canvasElement, "month"),
};
export const IntroBillingAnnual: Story = {
  tags: ["basic-intro", "ui-jam-revision"],
  args: {
    introStatus: "available",
    path: "/portal/server/example/billing?interval=year",
  },
  play: async ({ canvasElement }) => expectAccountTerms(canvasElement, "year"),
};
export const IntroMonthlySubscriber: Story = {
  tags: saleTags,
  args: {
    tier: "basic",
    introStatus: "ineligible",
    subscriptionDetails: monthlySubscriber,
    path: "/portal/server/example/billing",
  },
};
export const IntroAnnualSubscriber: Story = {
  ...IntroMonthlySubscriber,
  args: {
    ...IntroMonthlySubscriber.args,
    subscriptionDetails: annualSubscriber,
  },
};
export const IntroAnnualPaymentUnavailable: Story = {
  ...IntroAnnualSubscriber,
  args: {
    ...IntroAnnualSubscriber.args,
    subscriptionDetails: {
      ...annualSubscriber,
      firstYearPayment: { status: "unavailable" },
    },
  },
};
export const IntroAnnualNormalRenewal: Story = {
  ...IntroAnnualSubscriber,
  args: {
    ...IntroAnnualSubscriber.args,
    subscriptionDetails: { ...annualSubscriber, firstYearPayment: null },
  },
};
export const PaymentSettling: Story = {
  ...IntroAnnualSubscriber,
  tags: ["basic-intro", "payment-progress"],
  play: async ({ canvasElement }) => {
    const current = within(
      await within(canvasElement).findByTestId("billing-current-plan"),
    );
    await expect(current.getByText("Free", { exact: true })).toBeVisible();
    await expect(current.queryAllByText(/incomplete/i)).toHaveLength(0);
  },
  args: {
    ...IntroAnnualSubscriber.args,
    paymentSettling: true,
    tier: "free",
    billingSource: "stripe",
    subscriptionDetails: {
      ...annualSubscriber,
      paymentProgress: "processing",
      firstYearPayment: { status: "unavailable" },
    },
  },
};
export const PaymentNeedsAttention: Story = {
  ...PaymentSettling,
  tags: ["basic-intro", "payment-progress"],
  args: {
    ...PaymentSettling.args,
    subscriptionDetails: {
      ...annualSubscriber,
      paymentProgress: "action_required",
      firstYearPayment: { status: "unavailable" },
    },
  },
};
export const PaymentStatusUnavailable: Story = {
  ...PaymentSettling,
  tags: ["basic-intro", "payment-progress"],
  args: {
    ...PaymentSettling.args,
    subscriptionDetails: {
      ...annualSubscriber,
      paymentProgress: "unavailable",
      firstYearPayment: { status: "unavailable" },
    },
  },
};
export const IntroAnnualSharedRestriction: Story = {
  ...IntroAnnualSubscriber,
  args: {
    ...IntroAnnualSubscriber.args,
    subscriptionDetails: {
      ...annualSubscriber,
      planChangesRestricted: true,
      planChangeRestrictionEndsAt: null,
    },
  },
};
export const IntroSubscriberCanceled: Story = {
  ...IntroAnnualSubscriber,
  tags: ["cancellation-status"],
  args: {
    ...IntroAnnualSubscriber.args,
    cancellationAt: annualSubscriber.renewalAt,
    subscriptionDetails: { ...annualSubscriber, cancelAtPeriodEnd: true },
  },
  play: async ({ canvasElement }) => {
    const current = within(
      await within(canvasElement).findByTestId("billing-current-plan"),
    );
    await expect(
      current.getByText("Renewal off", { exact: true }),
    ).toBeVisible();
    await expect(current.queryByText(/next billing/)).toBeNull();
    await expect(
      current.getByRole("button", { name: "Turn renewal back on" }),
    ).toBeEnabled();
    await expect(current.queryByText("ACTIVE", { exact: true })).toBeNull();
  },
};
export const CancellationPriceUnavailable: Story = {
  ...IntroSubscriberCanceled,
  args: {
    ...IntroSubscriberCanceled.args,
    subscriptionDetails: { status: "unavailable" },
  },
  play: async ({ canvasElement }) => {
    const current = within(
      await within(canvasElement).findByTestId("billing-current-plan"),
    );
    await expect(
      await current.findByText(/Your Basic plan ends/),
    ).toBeVisible();
    await expect(current.queryByText(/next billing/)).toBeNull();
  },
};
export const IntroProviderUnavailable: Story = {
  ...IntroAnnualSubscriber,
  args: {
    ...IntroAnnualSubscriber.args,
    subscriptionDetails: { status: "unavailable" },
  },
};
export const IntroAnnualLight: Story = {
  ...IntroAnnual,
  args: { ...IntroAnnual.args, colorScheme: "light" },
};
export const IntroHomeLight: Story = {
  ...IntroHome,
  args: { ...IntroHome.args, colorScheme: "light" },
};
export const IntroHomeAnnualLight: Story = {
  ...IntroHomeAnnual,
  args: { ...IntroHomeAnnual.args, colorScheme: "light" },
};
export const IntroBillingFreeLight: Story = {
  ...IntroBillingFree,
  args: { ...IntroBillingFree.args, colorScheme: "light" },
};
export const IntroBillingAnnualLight: Story = {
  ...IntroBillingAnnual,
  args: { ...IntroBillingAnnual.args, colorScheme: "light" },
};
export const IntroAnnualSubscriberLight: Story = {
  ...IntroAnnualSubscriber,
  args: { ...IntroAnnualSubscriber.args, colorScheme: "light" },
};
export const IntroMonthlySubscriberLight: Story = {
  ...IntroMonthlySubscriber,
  args: { ...IntroMonthlySubscriber.args, colorScheme: "light" },
};

export const BillingExpiredSubscription: Story = {
  tags: ["integration-terminal-history"],
  args: {
    path: "/portal/server/example/billing",
    terminalStatus: "incomplete_expired",
    introStatus: "inactive",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByTestId("billing-current-plan"),
    ).toHaveTextContent("Free");
    const history = canvas.getByTestId("billing-payment-history");
    await userEvent.click(
      within(history).getByRole("button", { name: "Payment history" }),
    );
    await expect(history).toHaveTextContent("Previous subscription: Expired");
    await expect(history).not.toHaveTextContent("paid");
    await expect(
      canvas.getByRole("button", { name: "Get Basic again" }),
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: "Upgrade to Pro" }),
    ).toBeEnabled();
  },
};
export const DirectCanceledHistory: Story = {
  tags: ["integration-terminal-history"],
  args: { terminalStatus: "canceled", introStatus: "inactive" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Continue with Basic" }),
      ).toBeEnabled(),
    );
    await expect(
      canvas.getByRole("button", { name: "Continue with Pro" }),
    ).toBeEnabled();
  },
};
export const DirectExpiredHistory: Story = {
  ...DirectCanceledHistory,
  tags: ["integration-terminal-history"],
  args: { ...DirectCanceledHistory.args, terminalStatus: "incomplete_expired" },
};

export const BillingCompedTerminalHistory: Story = {
  tags: ["integration-comp-history"],
  args: {
    path: "/portal/server/example/billing",
    tier: "basic",
    billingSource: "manual_comp",
    terminalStatus: "canceled",
    introStatus: "inactive",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Start paying for Basic" }),
      ).toBeEnabled(),
    );
    await expect(canvas.getByTestId("billing-current-plan")).toHaveTextContent(
      "Basic",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Payment history", exact: true }),
    );
    await expect(
      canvas.getByTestId("billing-payment-history"),
    ).toHaveTextContent("Previous subscription: Canceled");
  },
};
export const DirectCompedTerminalHistory: Story = {
  tags: ["integration-comp-history"],
  args: {
    tier: "basic",
    billingSource: "manual_comp",
    terminalStatus: "incomplete_expired",
    introStatus: "inactive",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Continue with Basic" }),
      ).toBeEnabled(),
    );
    await expect(
      canvas.getByText("Current plan: Basic (complimentary)"),
    ).toBeVisible();
  },
};
export const HomeOfferUnavailable: Story = {
  tags: ["integration-offer-guards"],
  args: { path: "/", introStatus: "unavailable" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByTestId("home-cta-pro")).toBeEnabled(),
    );
    await expect(canvas.getByTestId("home-cta-basic")).toBeDisabled();
  },
};

export const BillingPlanChangeReview: Story = {
  tags: ["integration-plan-change"],
  args: {
    path: "/portal/server/example/billing",
    tier: "basic",
    subscriptionDetails: monthlySubscriber,
    introStatus: "available",
    change: { kind: "none", enabled: true },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Compare plans" }),
    );
    await waitFor(() =>
      expect(
        canvas.getByTestId("billing-plans").getBoundingClientRect().bottom + 1,
      ).toBeGreaterThanOrEqual(
        canvas.getByTestId("billing-plan-pro").getBoundingClientRect().bottom,
      ),
    );
    const root = canvasElement.ownerDocument.scrollingElement;
    if (!root) throw new Error("Missing document scroll container");
    root.scrollTop = root.scrollHeight;
    const before = root.scrollTop;
    await expect(before).toBeGreaterThan(0);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Review Pro" }),
    );
    await waitFor(() => expect(root.scrollTop).toBeLessThan(before));
    const review = await canvas.findByTestId("billing-change-review");
    await expect(review).toHaveTextContent("Change to Pro");
    await expect(review).toHaveTextContent("$9");
    await expect(canvas.getByTestId("billing-current-plan")).toHaveTextContent(
      "Basic",
    );
    await expect(
      within(review).getByRole("button", { name: "Confirm and pay $9" }),
    ).toBeEnabled();
  },
};
export const BillingScheduledChange: Story = {
  tags: ["integration-plan-change"],
  args: {
    ...BillingPlanChangeReview.args,
    tier: "pro",
    subscriptionDetails: {
      ...monthlySubscriber,
      priceId: "pro",
      unitAmount: 2400,
      discountedUnitAmount: null,
      discount: null,
    },
    change: {
      ...previewChangeReview({
        tier: "basic",
        interval: "month",
        expectedOffer: "basic_intro_v1",
      }),
      state: "scheduled",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Plan change scheduled"),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Cancel scheduled change" }),
    );
    await waitFor(() =>
      expect(
        canvas.queryByText("Plan change scheduled"),
      ).not.toBeInTheDocument(),
    );
  },
};

export const BillingPlanChangePayment: Story = {
  tags: ["integration-plan-change"],
  args: {
    ...BillingPlanChangeReview.args,
    change: {
      ...previewChangeReview({
        tier: "pro",
        interval: "month",
        expectedOffer: "none",
      }),
      state: "accepted",
      paymentUrl: "https://example.invalid/preview-payment",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const review = await canvas.findByTestId("billing-change-review");
    await expect(
      await within(review).findByRole("button", { name: "Continue payment" }),
    ).toBeEnabled();
    await expect(canvas.getByTestId("billing-current-plan")).toHaveTextContent(
      "Basic",
    );
    await expect(
      within(review).getByRole("button", { name: "Cancel change" }),
    ).toBeEnabled();
  },
};
export const BillingPlanChangeMobile: Story = {
  tags: ["integration-plan-change"],
  ...BillingPlanChangeReview,
  args: { ...BillingPlanChangeReview.args, width: 390 },
};
export const BillingScheduledChangePending: Story = {
  tags: ["integration-plan-change"],
  ...BillingScheduledChange,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByText("Plan change scheduled"),
    ).toBeVisible();
  },
};

export const BillingTerminalChangeRecovery: Story = {
  tags: ["integration-plan-change"],
  args: {
    ...BillingPlanChangeReview.args,
    tier: "free",
    terminalStatus: "canceled",
    subscriptionDetails: undefined,
    change: previewChangeReview({
      tier: "pro",
      interval: "month",
      expectedOffer: "none",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const review = await canvas.findByTestId("billing-change-review");
    await expect(canvas.getByTestId("billing-current-plan")).toHaveTextContent(
      "Free",
    );
    await userEvent.click(
      within(review).getByRole("button", { name: "Back", exact: true }),
    );
    await waitFor(() =>
      expect(
        canvas.queryByTestId("billing-change-review"),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: "Get Basic again" }),
      ).toBeEnabled(),
    );
  },
};

async function verifyRecoveryPreview({
  canvasElement,
}: {
  canvasElement: HTMLElement;
}) {
  await waitFor(() =>
    expect(
      within(canvasElement).getByTestId("billing-renewal-grace"),
    ).toBeVisible(),
  );
  await expect(
    within(canvasElement).queryByText("Something went wrong!"),
  ).not.toBeInTheDocument();
}
export const RenewalGraceBasic: Story = {
  play: verifyRecoveryPreview,
  args: {
    path: "/portal/server/example/billing",
    tier: "basic",
    recovery: renewalGraceFixture(),
  },
  tags: ["renewal-grace"],
};
export const RenewalGraceScheduled: Story = {
  play: verifyRecoveryPreview,
  args: {
    path: "/portal/server/example/billing",
    tier: "pro",
    recovery: renewalGraceFixture({ priorTier: "pro", scheduledChange: true }),
  },
  tags: ["renewal-grace"],
};
export const RenewalGraceCanceled: Story = {
  play: verifyRecoveryPreview,
  args: {
    path: "/portal/server/example/billing",
    tier: "pro",
    recovery: renewalGraceFixture({
      status: "canceled",
      priorTier: "pro",
      scheduledChange: true,
      paymentUrl: null,
    }),
  },
  tags: ["renewal-grace"],
};
export const RenewalGraceScheduledMobile: Story = {
  ...RenewalGraceScheduled,
  args: { ...RenewalGraceScheduled.args, width: 390 },
  tags: ["renewal-grace"],
};
export const RenewalGraceProcessing: Story = {
  play: verifyRecoveryPreview,
  args: {
    path: "/portal/server/example/billing",
    tier: "basic",
    recovery: renewalGraceFixture({
      status: "settlement_pending",
      paymentUrl: null,
    }),
  },
  tags: ["renewal-grace"],
};
