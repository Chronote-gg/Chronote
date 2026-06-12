import { beforeEach, describe, expect, it } from "@jest/globals";
import { getEntitlementGrantRepository } from "../../src/repositories/entitlementGrantRepository";
import { getSubscriptionRepository } from "../../src/repositories/subscriptionRepository";
import { resetMockStore } from "../../src/repositories/mockStore";
import {
  autoRevokeCoveredCompGrants,
  createManualEntitlementGrant,
  revokeManualEntitlementGrant,
} from "../../src/services/entitlementService";
import {
  clearGuildSubscriptionCache,
  resolveGuildSubscription,
} from "../../src/services/subscriptionService";

const freeGuildId = "111111111111111111";
const paidBasicGuildId = "1249723747896918109";

describe("entitlement grants", () => {
  beforeEach(() => {
    resetMockStore();
    clearGuildSubscriptionCache();
  });

  it("raises a free guild to a comped Basic effective tier", async () => {
    await createManualEntitlementGrant({
      guildId: freeGuildId,
      tier: "basic",
      createdBy: "admin-1",
      label: "Demo guild",
    });

    const resolved = await resolveGuildSubscription(freeGuildId);
    expect(resolved.tier).toBe("basic");
    expect(resolved.billingSource).toBe("manual_comp");
    expect(resolved.grantTier).toBe("basic");
    expect(resolved.activeGrant?.guildId).toBe(freeGuildId);
    expect(resolved.activeGrant).not.toHaveProperty("label");
  });

  it("invalidates a cached free resolution when a grant is created", async () => {
    await expect(resolveGuildSubscription(freeGuildId)).resolves.toMatchObject({
      tier: "free",
      billingSource: "free",
    });

    await createManualEntitlementGrant({
      guildId: freeGuildId,
      tier: "basic",
      createdBy: "admin-1",
    });

    await expect(resolveGuildSubscription(freeGuildId)).resolves.toMatchObject({
      tier: "basic",
      billingSource: "manual_comp",
    });
  });

  it("ignores expired active grants", async () => {
    await getEntitlementGrantRepository().write({
      grantId: "expired-grant",
      guildId: freeGuildId,
      tier: "pro",
      status: "active",
      source: "manual_comp",
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      createdBy: "admin-1",
    });

    const resolved = await resolveGuildSubscription(freeGuildId);
    expect(resolved.tier).toBe("free");
    expect(resolved.billingSource).toBe("free");
    expect(resolved.activeGrant).toBeNull();
  });

  it("does not treat incomplete Stripe subscriptions as paid entitlements", async () => {
    await getSubscriptionRepository().write({
      guildId: freeGuildId,
      status: "incomplete",
      tier: "basic",
      subscriptionType: "stripe",
      startDate: "2026-01-01T00:00:00.000Z",
      stripeCustomerId: "cus_incomplete",
      stripeSubscriptionId: "sub_incomplete",
    });

    await expect(resolveGuildSubscription(freeGuildId)).resolves.toMatchObject({
      tier: "free",
      billingSource: "free",
      stripeTier: null,
    });
  });

  it("lets a comped Pro grant outrank paid Basic", async () => {
    await createManualEntitlementGrant({
      guildId: paidBasicGuildId,
      tier: "pro",
      createdBy: "admin-1",
    });

    const resolved = await resolveGuildSubscription(paidBasicGuildId);
    expect(resolved.stripeTier).toBe("basic");
    expect(resolved.grantTier).toBe("pro");
    expect(resolved.tier).toBe("pro");
    expect(resolved.billingSource).toBe("manual_comp");
  });

  it("quietly revokes only same-or-higher covered grants", async () => {
    const proGrant = await createManualEntitlementGrant({
      guildId: paidBasicGuildId,
      tier: "pro",
      createdBy: "admin-1",
    });
    const basicGrant = await createManualEntitlementGrant({
      guildId: paidBasicGuildId,
      tier: "basic",
      createdBy: "admin-1",
    });

    await expect(
      autoRevokeCoveredCompGrants({
        guildId: paidBasicGuildId,
        paidTier: "basic",
        stripeSubscriptionId: "sub_basic",
      }),
    ).resolves.toBe(1);

    expect(
      (await getEntitlementGrantRepository().get(proGrant.grantId))?.status,
    ).toBe("active");
    expect(
      (await getEntitlementGrantRepository().get(basicGrant.grantId))?.status,
    ).toBe("revoked");

    await expect(
      autoRevokeCoveredCompGrants({
        guildId: paidBasicGuildId,
        paidTier: "pro",
        stripeSubscriptionId: "sub_pro",
      }),
    ).resolves.toBe(1);

    const revokedPro = await getEntitlementGrantRepository().get(
      proGrant.grantId,
    );
    expect(revokedPro?.status).toBe("revoked");
    expect(revokedPro?.autoRevokedByStripeSubscriptionId).toBe("sub_pro");
  });

  it("invalidates cached comped tiers when grants are revoked", async () => {
    const grant = await createManualEntitlementGrant({
      guildId: freeGuildId,
      tier: "basic",
      createdBy: "admin-1",
    });
    await expect(resolveGuildSubscription(freeGuildId)).resolves.toMatchObject({
      tier: "basic",
      billingSource: "manual_comp",
    });

    await revokeManualEntitlementGrant({
      grantId: grant.grantId,
      revokedBy: "admin-1",
    });

    await expect(resolveGuildSubscription(freeGuildId)).resolves.toMatchObject({
      tier: "free",
      billingSource: "free",
    });
  });

  it("invalidates cached comped tiers when grants are auto-revoked", async () => {
    await createManualEntitlementGrant({
      guildId: paidBasicGuildId,
      tier: "pro",
      createdBy: "admin-1",
    });
    await expect(
      resolveGuildSubscription(paidBasicGuildId),
    ).resolves.toMatchObject({
      tier: "pro",
      billingSource: "manual_comp",
    });

    await autoRevokeCoveredCompGrants({
      guildId: paidBasicGuildId,
      paidTier: "pro",
      stripeSubscriptionId: "sub_pro",
    });

    await expect(
      resolveGuildSubscription(paidBasicGuildId),
    ).resolves.toMatchObject({
      tier: "basic",
      billingSource: "stripe",
    });
  });
});
