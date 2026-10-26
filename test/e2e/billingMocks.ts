import type { RenewalRecoveryView } from "../../src/types/renewalRecovery";
import { introPlans as gracePlans } from "../../src/frontend/pages/basicIntroFixtures";
import type { RenewalView } from "../../src/types/renewal";
import { createRenewalFixture } from "../../src/frontend/pages/renewalFixtures";
import type { Page, Route } from "@playwright/test";
import type {
  BasicIntroOffer,
  ProviderSubscriptionDetails,
} from "../../src/types/pricing";
import {
  introPlans,
  monthlyIntroOffer,
  annualIntroOffer,
} from "../../src/frontend/pages/basicIntroFixtures";

export type IntroBillingOptions = {
  renewal?: RenewalView;
  stripeStatus?: "past_due" | "unpaid";
  status?: BasicIntroOffer["status"];
  details?: ProviderSubscriptionDetails;
  cancellationAt?: string | null;
  nextBillingDate?: string | null;
  legacy?: boolean;
  terminalStatus?: "canceled" | "incomplete_expired";
};

function introBillingStatus(options: IntroBillingOptions) {
  return (
    options.stripeStatus ??
    options.terminalStatus ??
    (options.details ? "active" : "free")
  );
}
function introBillingUsage(options: IntroBillingOptions) {
  if (options.terminalStatus)
    return { usedMinutes: 45, limitMinutes: 240, remainingMinutes: 195 };
  return options.details
    ? { usedMinutes: 45, limitMinutes: 1200, remainingMinutes: 1155 }
    : null;
}

function introBillingData(options: IntroBillingOptions) {
  return {
    tier: options.details ? "basic" : "free",
    billingSource: options.details || options.legacy ? "stripe" : "free",
    status: introBillingStatus(options),
    billingEnabled: true,
    hasStripeBilling: Boolean(
      options.details || options.legacy || options.terminalStatus,
    ),
    canManageBillingPortal: Boolean(
      options.details || options.legacy || options.terminalStatus,
    ),
    usage: introBillingUsage(options),
    subscriptionDetails: options.details,
    cancellationAt: options.cancellationAt ?? null,
    nextBillingDate: options.nextBillingDate ?? null,
  };
}

async function replaceBillingResponses(
  route: Route,
  values: Record<string, unknown>,
) {
  const url = new URL(route.request().url());
  const paths = decodeURIComponent(url.pathname.split("/trpc/")[1]).split(",");
  const replaced = (path: string) => Object.hasOwn(values, path);
  const entry = (path: string) => ({ result: { data: values[path] } });
  if (!paths.some(replaced)) return route.continue();
  if (paths.every(replaced)) {
    const entries = paths.map(entry);
    return route.fulfill({
      status: 200,
      json: url.searchParams.get("batch") === "1" ? entries : entries[0],
    });
  }
  const response = await route.fetch();
  const body = await response.json();
  const entries = Array.isArray(body) ? body : [body];
  const next = entries.map((original, index) =>
    replaced(paths[index]) ? entry(paths[index]) : original,
  );
  return route.fulfill({
    response,
    json: Array.isArray(body) ? next : next[0],
  });
}

export async function useIntroBilling(
  page: Page,
  options: IntroBillingOptions = {},
) {
  await page.route("**/trpc/**", async (route) => {
    const status = options.status ?? "available";
    const offers = {
      introOffer: status === "available" ? monthlyIntroOffer : { status },
      annualIntroOffer: status === "available" ? annualIntroOffer : { status },
    };
    return replaceBillingResponses(route, {
      "pricing.plans": { plans: introPlans, ...offers },
      "billing.change": { kind: "none", enabled: false },
      "billing.renewal": options.renewal ?? createRenewalFixture(options),
      "billing.me": { ...introBillingData(options), ...offers },
    });
  });
}

// Keep provider state out of UI purchase tests; the real mock runtime forces Pro.
export async function useFreeBilling(
  page: Page,
  {
    terminalStatus,
    grantTier,
  }: {
    terminalStatus?: "canceled" | "incomplete_expired";
    grantTier?: "basic" | "pro";
  } = {},
) {
  const limitMinutes =
    grantTier === "pro" ? null : grantTier === "basic" ? 1200 : 240;
  const usage = terminalStatus
    ? {
        usedMinutes: 45,
        limitMinutes,
        remainingMinutes: limitMinutes === null ? null : limitMinutes - 45,
      }
    : null;
  const billingData = {
    tier: grantTier ?? "free",
    billingSource: grantTier ? "manual_comp" : "free",
    grantTier: grantTier ?? null,
    status: grantTier ? "comped" : (terminalStatus ?? "free"),
    stripeStatus: terminalStatus ?? null,
    billingEnabled: true,
    hasStripeBilling: Boolean(terminalStatus),
    canManageBillingPortal: Boolean(terminalStatus),
    usage,
  };
  await page.route("**/trpc/**", (route) =>
    replaceBillingResponses(route, {
      "billing.change": { kind: "none", enabled: false },
      "billing.renewal": createRenewalFixture({
        terminalStatus,
        canManageBilling: Boolean(terminalStatus),
      }),
      "billing.me": billingData,
    }),
  );
}

export async function useRenewalGrace(
  page: Page,
  options: { view: RenewalRecoveryView; tier?: "free" | "basic" | "pro" },
) {
  await page.route("**/trpc/**", async (route) => {
    const view = options.view;
    if (
      new URL(route.request().url()).pathname.includes(
        "billing.cancelRenewalPayment",
      ) &&
      view.status !== "none"
    )
      options.view = { ...view, status: "canceled", paymentUrl: null };
    return replaceBillingResponses(route, {
      "pricing.plans": {
        plans: gracePlans,
        introOffer: { status: "inactive" },
        annualIntroOffer: { status: "inactive" },
      },
      "billing.change": { kind: "none", enabled: false },
      "billing.renewal": {
        state: { kind: "unavailable", knownEndsAt: null },
        canManageBilling: true,
        lifecycleAnalyticsEnabled: false,
      },
      "billing.cancelRenewalPayment": options.view,
      "billing.me": {
        tier: options.tier ?? "pro",
        status:
          options.view.status === "canceled"
            ? "canceled"
            : options.view.status === "none"
              ? "active"
              : "past_due",
        stripeStatus:
          options.view.status === "canceled"
            ? "canceled"
            : options.view.status === "none"
              ? "active"
              : "past_due",
        billingEnabled: true,
        hasStripeBilling: true,
        billingSource: "stripe",
        canManageBillingPortal: true,
        grantTier: null,
        renewalRecovery: options.view,
        usage: { usedMinutes: 45, limitMinutes: null, remainingMinutes: null },
      },
    });
  });
}
