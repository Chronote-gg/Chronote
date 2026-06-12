import { randomUUID } from "node:crypto";
import { getEntitlementGrantRepository } from "../repositories/entitlementGrantRepository";
import { nowIso } from "../utils/time";
import { clearGuildSubscriptionCache } from "./subscriptionCache";
import type {
  EntitlementGrant,
  EntitlementGrantStatus,
  EntitlementGrantTier,
} from "../types/db";

export type BillingSource = "free" | "stripe" | "manual_comp" | "forced";
export type KnownTier = "free" | EntitlementGrantTier;

export type PublicEntitlementGrant = Pick<
  EntitlementGrant,
  | "grantId"
  | "guildId"
  | "tier"
  | "status"
  | "source"
  | "startsAt"
  | "expiresAt"
  | "publicNote"
>;

export type AdminEntitlementGrant = EntitlementGrant & {
  effectiveStatus: EntitlementGrantStatus;
};

const tierRank: Record<KnownTier, number> = {
  free: 0,
  basic: 1,
  pro: 2,
};

const normalizeText = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function isPaidTier(tier?: string | null): tier is EntitlementGrantTier {
  return tier === "basic" || tier === "pro";
}

export function isSameOrHigherTier(
  paidTier: EntitlementGrantTier,
  grantTier: EntitlementGrantTier,
): boolean {
  return tierRank[paidTier] >= tierRank[grantTier];
}

export function highestTier(a: KnownTier, b: KnownTier): KnownTier {
  return tierRank[a] >= tierRank[b] ? a : b;
}

export function getGrantEffectiveStatus(
  grant: EntitlementGrant,
  at = new Date(),
): EntitlementGrantStatus {
  if (grant.status !== "active") return grant.status;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= at.getTime()) {
    return "expired";
  }
  return "active";
}

export function isGrantCurrentlyActive(
  grant: EntitlementGrant,
  at = new Date(),
): boolean {
  if (getGrantEffectiveStatus(grant, at) !== "active") return false;
  return Date.parse(grant.startsAt) <= at.getTime();
}

export function toPublicEntitlementGrant(
  grant: EntitlementGrant | null | undefined,
): PublicEntitlementGrant | null {
  if (!grant) return null;
  return {
    grantId: grant.grantId,
    guildId: grant.guildId,
    tier: grant.tier,
    status: getGrantEffectiveStatus(grant),
    source: grant.source,
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    publicNote: grant.publicNote,
  };
}

export async function listAdminEntitlementGrants(filters?: {
  guildId?: string;
  status?: EntitlementGrantStatus;
  limit?: number;
}): Promise<AdminEntitlementGrant[]> {
  const limit = filters?.limit;
  const grants = await getEntitlementGrantRepository().list({
    guildId: normalizeText(filters?.guildId),
    status: filters?.status === "expired" ? undefined : filters?.status,
    limit: filters?.status === "expired" ? undefined : limit,
  });
  const items = grants
    .map((grant) => ({
      ...grant,
      effectiveStatus: getGrantEffectiveStatus(grant),
    }))
    .filter(
      (grant) => !filters?.status || grant.effectiveStatus === filters.status,
    );
  return limit ? items.slice(0, limit) : items;
}

export async function createManualEntitlementGrant(input: {
  guildId: string;
  tier: EntitlementGrantTier;
  createdBy: string;
  expiresAt?: string | null;
  label?: string | null;
  reason?: string | null;
  internalNotes?: string | null;
  publicNote?: string | null;
  recipientName?: string | null;
  recipientContact?: string | null;
}): Promise<EntitlementGrant> {
  const createdAt = nowIso();
  const startsAt = createdAt;
  const expiresAt = normalizeText(input.expiresAt);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(startsAt)) {
    throw new Error("Grant expiry must be in the future");
  }
  const grant: EntitlementGrant = {
    grantId: randomUUID(),
    guildId: input.guildId.trim(),
    tier: input.tier,
    status: "active",
    source: "manual_comp",
    startsAt,
    expiresAt,
    createdAt,
    createdBy: input.createdBy,
    updatedAt: createdAt,
    updatedBy: input.createdBy,
    label: normalizeText(input.label),
    reason: normalizeText(input.reason),
    internalNotes: normalizeText(input.internalNotes),
    publicNote: normalizeText(input.publicNote),
    recipientName: normalizeText(input.recipientName),
    recipientContact: normalizeText(input.recipientContact),
  };
  await getEntitlementGrantRepository().write(grant);
  clearGuildSubscriptionCache(grant.guildId);
  return grant;
}

export async function revokeManualEntitlementGrant(input: {
  grantId: string;
  revokedBy: string;
  revocationReason?: string | null;
}): Promise<void> {
  const repo = getEntitlementGrantRepository();
  const existing = await repo.get(input.grantId);
  await repo.revoke({
    grantId: input.grantId,
    revokedAt: nowIso(),
    revokedBy: input.revokedBy,
    revocationReason: normalizeText(input.revocationReason) ?? "manual_revoke",
  });
  if (existing) {
    clearGuildSubscriptionCache(existing.guildId);
  }
}

export async function getBestActiveEntitlementGrantForGuild(
  guildId: string,
): Promise<EntitlementGrant | null> {
  const grants =
    await getEntitlementGrantRepository().listActiveForGuild(guildId);
  const active = grants.filter((grant) => isGrantCurrentlyActive(grant));
  active.sort((a, b) => {
    const tierDiff = tierRank[b.tier] - tierRank[a.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return active[0] ?? null;
}

export async function autoRevokeCoveredCompGrants(input: {
  guildId: string;
  paidTier: EntitlementGrantTier;
  stripeSubscriptionId?: string | null;
  revokedBy?: string;
}): Promise<number> {
  const grants = await getEntitlementGrantRepository().listActiveForGuild(
    input.guildId,
  );
  const covered = grants.filter(
    (grant) =>
      isGrantCurrentlyActive(grant) &&
      isSameOrHigherTier(input.paidTier, grant.tier),
  );
  await Promise.all(
    covered.map((grant) =>
      getEntitlementGrantRepository().revoke({
        grantId: grant.grantId,
        revokedAt: nowIso(),
        revokedBy: input.revokedBy ?? "stripe",
        revocationReason: "stripe_same_or_higher_tier",
        autoRevokedByStripeSubscriptionId:
          input.stripeSubscriptionId ?? undefined,
      }),
    ),
  );
  if (covered.length > 0) {
    clearGuildSubscriptionCache(input.guildId);
  }
  return covered.length;
}
