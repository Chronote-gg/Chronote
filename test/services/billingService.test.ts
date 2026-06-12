import { describe, expect, it, jest } from "@jest/globals";
import type Stripe from "stripe";
import {
  getMockBillingSnapshot,
  resolvePromotionCodeId,
} from "../../src/services/billingService";
import { resetMockStore } from "../../src/repositories/mockStore";
import { createManualEntitlementGrant } from "../../src/services/entitlementService";
import { clearGuildSubscriptionCache } from "../../src/services/subscriptionService";

describe("resolvePromotionCodeId", () => {
  it("returns null for blank codes", async () => {
    const stripe = {
      promotionCodes: {
        list: jest.fn(),
      },
    } satisfies Pick<Stripe, "promotionCodes">;

    await expect(resolvePromotionCodeId(stripe, " ")).resolves.toBeNull();
    expect(stripe.promotionCodes.list).not.toHaveBeenCalled();
  });

  it("returns the first matching promotion code id", async () => {
    const stripe = {
      promotionCodes: {
        list: jest.fn().mockResolvedValue({ data: [{ id: "promo_123" }] }),
      },
    } satisfies Pick<Stripe, "promotionCodes">;

    await expect(resolvePromotionCodeId(stripe, "SAVE20")).resolves.toBe(
      "promo_123",
    );
    expect(stripe.promotionCodes.list).toHaveBeenCalledWith({
      code: "SAVE20",
      active: true,
      limit: 1,
    });
  });

  it("returns null when no promo codes match", async () => {
    const stripe = {
      promotionCodes: {
        list: jest.fn().mockResolvedValue({ data: [] }),
      },
    } satisfies Pick<Stripe, "promotionCodes">;

    await expect(resolvePromotionCodeId(stripe, "MISSING")).resolves.toBeNull();
  });
});

describe("getMockBillingSnapshot", () => {
  it("exposes comped grant metadata without Stripe billing management", async () => {
    resetMockStore();
    clearGuildSubscriptionCache();
    await createManualEntitlementGrant({
      guildId: "111111111111111111",
      tier: "basic",
      createdBy: "admin-1",
      publicNote: "Thanks for trying Chronote.",
    });

    const snapshot = await getMockBillingSnapshot("111111111111111111");
    expect(snapshot.tier).toBe("basic");
    expect(snapshot.status).toBe("comped");
    expect(snapshot.billingSource).toBe("manual_comp");
    expect(snapshot.grantTier).toBe("basic");
    expect(snapshot.activeGrant?.publicNote).toBe(
      "Thanks for trying Chronote.",
    );
    expect(snapshot.hasStripeBilling).toBe(false);
    expect(snapshot.canManageBillingPortal).toBe(false);
  });
});
