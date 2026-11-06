import { z } from "zod";
import { getEntitlementGrantRepository } from "../repositories/entitlementGrantRepository";

const grantHistory = z.object({
  guildId: z.string(),
  tier: z.enum(["basic", "pro"]),
  status: z.enum(["active", "expired", "revoked"]),
  source: z.literal("manual_comp"),
  startsAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
});
const rank = { basic: 1, pro: 2 };

function period(raw: unknown, guildId: string) {
  const parsed = grantHistory.safeParse(raw);
  if (!parsed.success || parsed.data.guildId !== guildId) {
    throw new Error("Invalid entitlement grant usage history");
  }
  const grant = parsed.data;
  const start = Date.parse(grant.startsAt);
  const expiry = grant.expiresAt ? Date.parse(grant.expiresAt) : Infinity;
  const revocation = grant.revokedAt ? Date.parse(grant.revokedAt) : Infinity;
  if (
    expiry <= start ||
    (grant.status === "expired" && !grant.expiresAt) ||
    (grant.status === "revoked") !== Boolean(grant.revokedAt)
  ) {
    throw new Error("Invalid entitlement grant usage history");
  }
  return { start, expiry, end: Math.min(expiry, revocation), tier: grant.tier };
}

export async function getGrantUsageResetAt(
  guildId: string,
  at: Date,
): Promise<number | null> {
  const now = at.getTime();
  if (!Number.isFinite(now)) {
    throw new Error("Invalid grant usage history evaluation time");
  }
  const grants = await getEntitlementGrantRepository().list({ guildId });
  const periods = grants.map((grant) => period(grant, guildId));
  let latest: number | null = null;
  // shortcut: retained periods cannot reconstruct expiry dates edited after expiry.
  // Preserve expiry history before adding support for that operator action.
  for (const ended of periods) {
    const expiry = ended.expiry;
    if (expiry > now || ended.end !== expiry) continue;
    const continues = periods.some(
      (other) =>
        other.start <= expiry &&
        other.end > expiry &&
        rank[other.tier] >= rank[ended.tier],
    );
    if (!continues) latest = Math.max(latest ?? expiry, expiry);
  }
  return latest;
}
