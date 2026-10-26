import type { FirstMeetingState } from "../../types/firstMeeting";
import type { RenewalRecoveryView } from "../../types/renewalRecovery";
import type { BillingChangeView } from "../../types/billingChange";
import { previewChangeReview } from "../pages/billingChangeFixtures";
import type { RenewalView } from "../../types/renewal";
import { createRenewalFixture } from "../pages/renewalFixtures";
import type { TerminalSubscriptionStatus } from "../utils/billingManagement";
import { useEffect, useState } from "react";
import { useMantineColorScheme } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { httpBatchLink } from "@trpc/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { trpc } from "../services/trpc";
import {
  AuthenticatedPreviewProviders,
  createPreviewQueryClient,
} from "./AuthenticatedPreviewProviders";
import Upgrade from "../pages/Upgrade";
import UpgradeServerSelect from "../pages/UpgradeServerSelect";
import Billing from "../pages/Billing";
import Join from "../pages/Join";
import LibraryPage from "../pages/library/LibraryPage";
import PromoLanding from "../pages/PromoLanding";
import Home from "../pages/Home";
import type {
  BasicIntroOffer,
  ProviderSubscriptionDetails,
} from "../../types/pricing";
import {
  introPlans,
  monthlyIntroOffer,
  annualIntroOffer,
} from "../pages/basicIntroFixtures";

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
  firstMeetingState?: FirstMeetingState;
  recovery?: RenewalRecoveryView;
  change?: BillingChangeView;
  width?: number;
  renewal?: RenewalView;
  path?: string;
  tier?: "free" | "basic" | "pro";
  colorScheme?: "light" | "dark";
  signedIn?: boolean;
  errorFor?:
    | "billing.me"
    | "pricing.plans"
    | "servers.listEligible"
    | "meetings.firstMeeting";
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
  firstMeetingState,
  renewal,
}: UpgradePreviewProps): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "meetings.firstMeeting": firstMeetingState ?? { kind: "guide" },
    "meetings.list": { meetings: [] },
    "notion.automationStatus": { configured: false },
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
  firstMeetingState,
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
  const [queryClient] = useState(createPreviewQueryClient);
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
              firstMeetingState,
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
    const marketing = createRoute({
      getParentRoute: () => root,
      id: "marketing",
      component: Outlet,
    });
    const routes = [
      createRoute({ getParentRoute: () => root, path: "/", component: Home }),
      createRoute({
        getParentRoute: () => root,
        path: "/promo/$code",
        component: PromoLanding,
      }),
      marketing.addChildren([
        createRoute({
          getParentRoute: () => marketing,
          path: "/join",
          component: Join,
          validateSearch: (search) => search,
        }),
      ]),
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
        path: "/portal/server/$serverId/library",
        component: LibraryPage,
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
