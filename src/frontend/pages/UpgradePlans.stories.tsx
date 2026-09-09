import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { useMantineColorScheme } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, within } from "storybook/test";
import { trpc } from "../services/trpc";
import { AuthProvider } from "../contexts/AuthContext";
import { GuildProvider } from "../contexts/GuildContext";
import Upgrade from "./Upgrade";
import UpgradeServerSelect from "./UpgradeServerSelect";
import Billing from "./Billing";

function UpgradePreview({
  path = "/upgrade/select-server?serverId=example",
  tier = "free",
  colorScheme = "dark",
}: {
  path?: string;
  tier?: "free" | "basic" | "pro";
  colorScheme?: "light" | "dark";
}) {
  const { setColorScheme } = useMantineColorScheme();
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
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async (url) => {
            const data: Record<string, unknown> = {
              "auth.me": {
                id: "story-user",
                username: "Preview",
                avatar: null,
              },
              "servers.listEligible": {
                guilds: [
                  { id: "example", name: "Engineering HQ", canManage: true },
                ],
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
              "billing.me": {
                tier,
                status: tier === "free" ? "free" : "active",
                billingSource: tier === "free" ? "default" : "stripe",
                stripeTier: tier === "free" ? null : tier,
                grantTier: null,
                activeGrant: null,
                nextBillingDate: null,
                stripeCustomerId: null,
                hasStripeBilling: tier !== "free",
                canManageBillingPortal: tier !== "free",
                upgradeUrl: null,
                portalUrl: null,
                billingEnabled: true,
                stripeMode: "test",
                usage: {
                  usedMinutes: 45,
                  limitMinutes:
                    tier === "pro" ? null : tier === "basic" ? 1200 : 240,
                  remainingMinutes:
                    tier === "pro" ? null : tier === "basic" ? 1155 : 195,
                },
              },
            };
            const paths = new URL(String(url), window.location.origin).pathname
              .split("/")
              .at(-1)!
              .split(",");
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
    }),
  );
  const [router] = useState(() => {
    localStorage.setItem("mn-selected-guild", "example");
    const root = createRootRoute({ component: Outlet });
    const routes = [
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
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <GuildProvider>
            <div
              style={{
                padding: 24,
                background: "var(--mantine-color-body)",
                minHeight: "100vh",
              }}
            >
              <RouterProvider router={router} />
            </div>
          </GuildProvider>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/UpgradePlans",
  tags: ["upgrade-plans"],
  component: UpgradePreview,
} satisfies Meta<typeof UpgradePreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NewBuyer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: "Continue to Stripe (Basic)" }),
    ).toBeEnabled();
    await expect(canvas.getByText("Recommended")).toBeVisible();
  },
};
export const NewBuyerLight: Story = {
  ...NewBuyer,
  args: { colorScheme: "light" },
};
export const NewBuyerNarrow: Story = {
  play: async ({ canvasElement }) => {
    const button = await within(canvasElement).findByRole("button", {
      name: "Continue to Stripe (Basic)",
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
};
export const ExistingBasic: Story = { args: { tier: "basic" } };
export const ExistingPro: Story = { args: { tier: "pro" } };
export const Landing: Story = { args: { path: "/upgrade" } };
export const BillingFree: Story = {
  args: { path: "/portal/server/example/billing" },
};
export const BillingPaid: Story = {
  args: { path: "/portal/server/example/billing", tier: "basic" },
};
