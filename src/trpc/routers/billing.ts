import { cancelRenewalRecovery } from "../../services/renewalRecoveryService";
import { getRenewalRecoveryView } from "../../services/renewalRecoveryView";
import {
  prepareBillingChange,
  readBillingChange,
  confirmBillingChange,
  cancelBillingChange,
} from "../../services/billingChangeService";
import {
  billingChangeSelectionSchema,
  type BillingChangeView,
} from "../../types/billingChange";
import {
  readRenewalState,
  restoreRenewal,
} from "../../services/renewalReactivationService";
import { renewalRequestSchema, type RenewalView } from "../../types/renewal";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  BillingActionError,
  buildBillingDisabledSnapshot,
  createCheckoutSession,
  createPortalSession,
  getBillingSnapshot,
  getMockBillingSnapshot,
  resolvePromotionCodeId,
  seedMockSubscription,
} from "../../services/billingService";
import { resolvePaidPlanPriceId } from "../../services/pricingService";
import { getStripeClient } from "../../services/stripeClient";
import { config } from "../../services/configService";
import { requireManageGuild } from "../permissions";
import { authedProcedure, manageGuildProcedure, router } from "../trpc";
import type { BillingInterval, PaidTier } from "../../types/pricing";
import {
  PURCHASE_SOURCES,
  RECORDING_LIMIT_TYPES,
  RECORDING_LIMIT_SURFACES,
  resolveRecordingLimitContext,
  recordingLimitAnalytics,
} from "../../utils/purchaseAnalytics";
import { captureEvent } from "../../services/analyticsService";

const me = authedProcedure
  .input(z.object({ serverId: z.string().optional() }))
  .query(async ({ ctx, input }) => {
    if (!input.serverId) {
      return buildBillingDisabledSnapshot();
    }
    await requireManageGuild({
      accessToken: ctx.user.accessToken,
      guildId: input.serverId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    if (config.mock.enabled) {
      return getMockBillingSnapshot(input.serverId);
    }
    const stripe = getStripeClient();
    if (!stripe || !config.stripe.secretKey) {
      return buildBillingDisabledSnapshot();
    }
    return getBillingSnapshot({
      stripe,
      guildId: input.serverId,
      payerId: ctx.user.id,
    });
  });

const checkout = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      tier: z.enum(["basic", "pro"]),
      interval: z.enum(["month", "year"]).default("month"),
      promotionCode: z.string().optional(),
      savedPromotionCode: z.string().max(200).optional(),
      expectedOffer: z
        .enum(["none", "basic_intro_v1", "basic_annual_intro_v1"])
        .optional(),
      offerChoice: z.enum(["automatic", "promotion"]).default("automatic"),
      source: z.enum(PURCHASE_SOURCES).catch("unknown").default("direct"),
      limitType: z.enum(RECORDING_LIMIT_TYPES).optional().catch(undefined),
      limitSurface: z
        .enum(RECORDING_LIMIT_SURFACES)
        .optional()
        .catch(undefined),
      analyticsDisabled: z.boolean().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    const analyticsAllowed =
      !input.analyticsDisabled && ctx.req.headers.dnt !== "1";
    if (config.mock.enabled) {
      await seedMockSubscription(input.serverId);
      return { url: `/portal/server/${input.serverId}/billing?mock=checkout` };
    }
    const stripe = getStripeClient();
    if (!stripe) {
      if (analyticsAllowed)
        captureEvent("billing_checkout_rejected", {
          userId: ctx.user.id,
          guildId: input.serverId,
          properties: {
            reason: "billing_disabled",
            surface: "billing",
            source: input.source,
            ...recordingLimitAnalytics(input),
            event_version: 1,
          },
        });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe not configured",
      });
    }
    let reason = "provider_failed";
    try {
      if (
        input.promotionCode?.trim() &&
        input.savedPromotionCode?.trim() &&
        input.promotionCode.trim() !== input.savedPromotionCode.trim()
      )
        throw new BillingActionError(
          "BAD_REQUEST",
          "Saved and selected promotion codes do not match.",
          "discount_choice_required",
        );
      let priceId =
        (await resolvePaidPlanPriceId({
          stripe,
          tier: input.tier as PaidTier,
          interval: input.interval as BillingInterval,
        })) || null;
      if (
        !priceId &&
        input.tier === "basic" &&
        input.interval === "month" &&
        config.stripe.priceBasic
      ) {
        priceId = config.stripe.priceBasic;
      }
      if (!priceId) {
        reason = "price_missing";
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Pricing unavailable for selected plan",
        });
      }
      const promotionCode = input.promotionCode?.trim();
      let promotionCodeId: string | null = null;
      if (promotionCode) {
        promotionCodeId = await resolvePromotionCodeId(stripe, promotionCode);
        if (!promotionCodeId) {
          reason = "promotion_invalid";
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Invalid promotion code",
          });
        }
      }
      const url = await createCheckoutSession({
        stripe,
        user: {
          id: ctx.user.id,
          email: ctx.user.email ?? undefined,
          username: ctx.user.username ?? undefined,
        },
        guildId: input.serverId,
        priceId,
        promotionCodeId,
        promotionCode,
        savedPromotionCode: input.savedPromotionCode?.trim(),
        expectedOffer: input.expectedOffer,
        offerChoice: input.offerChoice,
        tier: input.tier as PaidTier,
        interval: input.interval as BillingInterval,
        source: input.source,
        ...resolveRecordingLimitContext(input),
        analyticsAllowed,
      });
      return { url };
    } catch (err) {
      if (analyticsAllowed)
        captureEvent("billing_checkout_rejected", {
          userId: ctx.user.id,
          guildId: input.serverId,
          properties: {
            reason: err instanceof BillingActionError ? err.reason : reason,
            surface: "billing",
            source: input.source,
            ...recordingLimitAnalytics(input),
            tier: input.tier,
            interval: input.interval,
            event_version: 1,
          },
        });
      if (err instanceof BillingActionError) {
        throw new TRPCError({ code: err.code, message: err.message });
      }
      if (err instanceof TRPCError) {
        throw err;
      }
      console.error("Stripe checkout error", err);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to create checkout session",
      });
    }
  });

const portal = manageGuildProcedure
  .input(z.object({ serverId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    if (config.mock.enabled) {
      return { url: `/portal/server/${input.serverId}/billing?mock=portal` };
    }
    const stripe = getStripeClient();
    if (!stripe) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe not configured",
      });
    }
    try {
      const url = await createPortalSession({
        stripe,
        user: {
          id: ctx.user.id,
          email: ctx.user.email ?? undefined,
          username: ctx.user.username ?? undefined,
        },
        guildId: input.serverId,
      });
      return { url };
    } catch (err) {
      if (err instanceof BillingActionError) {
        throw new TRPCError({ code: err.code, message: err.message });
      }
      console.error("Stripe portal error", err);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to create portal session",
      });
    }
  });

const renewal = manageGuildProcedure
  .input(z.object({ serverId: z.string().min(1) }).strict())
  .query(async ({ ctx, input }): Promise<RenewalView> => {
    if (config.mock.enabled)
      return {
        state: { kind: "not_applicable" },
        canManageBilling: false,
        lifecycleAnalyticsEnabled: false,
      };
    const stripe = getStripeClient();
    if (!stripe)
      return {
        state: { kind: "unavailable", knownEndsAt: null },
        canManageBilling: false,
        lifecycleAnalyticsEnabled: false,
      };
    return readRenewalState({
      stripe,
      guildId: input.serverId,
      payerId: ctx.user.id,
    });
  });
const reactivateRenewal = manageGuildProcedure
  .input(
    z
      .object({
        serverId: z.string().min(1),
        request: renewalRequestSchema,
        analyticsOptOut: z.boolean().default(false),
      })
      .strict(),
  )
  .mutation(async ({ ctx, input }) => {
    if (config.mock.enabled) return { kind: "changed" } as const;
    const stripe = getStripeClient();
    if (!stripe)
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe not configured",
      });
    try {
      return await restoreRenewal({
        stripe,
        guildId: input.serverId,
        payerId: ctx.user.id,
        request: input.request,
        analyticsOptOut: input.analyticsOptOut || ctx.req.headers.dnt === "1",
      });
    } catch (error) {
      if (error instanceof BillingActionError)
        throw new TRPCError({ code: error.code, message: error.message });
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to check renewal. Check status before trying again.",
      });
    }
  });

async function billingChangeResult<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof BillingActionError)
      throw new TRPCError({ code: error.code, message: error.message });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        "Unable to check this change. Check its status before trying again.",
    });
  }
}
function changeStripe() {
  const stripe = getStripeClient();
  if (!stripe)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Billing is unavailable.",
    });
  return stripe;
}
const change = manageGuildProcedure
  .input(z.object({ serverId: z.string().min(1) }).strict())
  .query(async ({ ctx, input }) => {
    const stripe = getStripeClient();
    if (!stripe)
      return { kind: "none", enabled: false } satisfies BillingChangeView;
    return billingChangeResult(() =>
      readBillingChange({
        stripe,
        guildId: input.serverId,
        payerId: ctx.user.id,
      }),
    );
  });
const prepareChange = manageGuildProcedure
  .input(
    z
      .object({
        serverId: z.string().min(1),
        selection: billingChangeSelectionSchema,
      })
      .strict(),
  )
  .mutation(({ ctx, input }) =>
    billingChangeResult(() =>
      prepareBillingChange({
        stripe: changeStripe(),
        guildId: input.serverId,
        payerId: ctx.user.id,
        selection: input.selection,
      }),
    ),
  );
const confirmChange = manageGuildProcedure
  .input(
    z
      .object({
        serverId: z.string().min(1),
        operationId: z.uuid(),
        revision: z.string().min(1),
      })
      .strict(),
  )
  .mutation(({ ctx, input }) =>
    billingChangeResult(() =>
      confirmBillingChange({
        stripe: changeStripe(),
        guildId: input.serverId,
        payerId: ctx.user.id,
        operationId: input.operationId,
        revision: input.revision,
      }),
    ),
  );
const cancelChange = manageGuildProcedure
  .input(
    z.object({ serverId: z.string().min(1), operationId: z.uuid() }).strict(),
  )
  .mutation(({ ctx, input }) =>
    billingChangeResult(() =>
      cancelBillingChange({
        stripe: changeStripe(),
        guildId: input.serverId,
        payerId: ctx.user.id,
        operationId: input.operationId,
      }),
    ),
  );

const cancelRenewalPayment = manageGuildProcedure
  .input(z.object({ serverId: z.string().min(1) }).strict())
  .mutation(({ ctx, input }) =>
    billingChangeResult(async () => {
      const context = {
        stripe: changeStripe(),
        guildId: input.serverId,
        payerId: ctx.user.id,
        now: Math.floor(Date.now() / 1000),
      };
      await cancelRenewalRecovery(context);
      return getRenewalRecoveryView(context);
    }),
  );
export const billingRouter = router({
  cancelRenewalPayment,
  change,
  prepareChange,
  confirmChange,
  cancelChange,
  renewal,
  reactivateRenewal,
  me,
  checkout,
  portal,
});
