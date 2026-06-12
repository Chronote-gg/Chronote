import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getEntitlementGrantRepository } from "../../repositories/entitlementGrantRepository";
import {
  createManualEntitlementGrant,
  listAdminEntitlementGrants,
  revokeManualEntitlementGrant,
} from "../../services/entitlementService";
import { listBotGuildsCached } from "../../services/discordCacheService";
import { superAdminProcedure, router } from "../trpc";

const guildIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17,25}$/, {
    message: "Enter a valid Discord guild ID",
  });
const tierSchema = z.enum(["basic", "pro"]);
const statusSchema = z.enum(["active", "revoked", "expired"]);
const optionalText = z
  .string()
  .trim()
  .max(2000)
  .optional()
  .nullable()
  .transform((value) => value || undefined);

const resolveGuildsById = async (guildIds: Set<string>) => {
  if (guildIds.size === 0) return {};
  try {
    const guilds = await listBotGuildsCached();
    return Object.fromEntries(
      guilds
        .filter((guild) => guildIds.has(guild.id))
        .map((guild) => [guild.id, guild.name]),
    );
  } catch (error) {
    console.error(
      "Unable to resolve guild names for entitlement grants.",
      error,
    );
    return {};
  }
};

const list = superAdminProcedure
  .input(
    z.object({
      guildId: z.string().trim().optional(),
      status: statusSchema.optional(),
      tier: tierSchema.optional(),
      limit: z.number().min(1).max(200).optional(),
    }),
  )
  .query(async ({ input }) => {
    const limit = input.limit ?? 100;
    const items = (
      await listAdminEntitlementGrants({
        guildId: input.guildId,
        status: input.status,
        limit: input.tier ? undefined : limit,
      })
    )
      .filter((grant) => !input.tier || grant.tier === input.tier)
      .slice(0, limit);
    const guildIds = new Set(items.map((item) => item.guildId));
    const guildsById = await resolveGuildsById(guildIds);
    return {
      items,
      guildsById,
      installedGuildIds: Object.keys(guildsById),
    };
  });

const create = superAdminProcedure
  .input(
    z.object({
      guildId: guildIdSchema,
      tier: tierSchema,
      expiresAt: z.string().datetime().optional().nullable(),
      label: optionalText,
      reason: optionalText,
      internalNotes: optionalText,
      publicNote: optionalText,
      recipientName: optionalText,
      recipientContact: optionalText,
    }),
  )
  .mutation(async ({ ctx, input }) => {
    try {
      const grant = await createManualEntitlementGrant({
        ...input,
        createdBy: ctx.user.id,
      });
      return { grant };
    } catch (error) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          error instanceof Error
            ? error.message
            : "Unable to create entitlement grant",
      });
    }
  });

const revoke = superAdminProcedure
  .input(
    z.object({
      grantId: z.string().min(1),
      revocationReason: optionalText,
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const grant = await getEntitlementGrantRepository().get(input.grantId);
    if (!grant) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Entitlement grant not found",
      });
    }
    await revokeManualEntitlementGrant({
      grantId: input.grantId,
      revokedBy: ctx.user.id,
      revocationReason: input.revocationReason,
    });
    return { ok: true };
  });

export const adminEntitlementsRouter = router({
  list,
  create,
  revoke,
});
