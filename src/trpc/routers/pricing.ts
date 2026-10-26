import { TRPCError } from "@trpc/server";
import { getPublicPricingSnapshot } from "../../services/publicPricingService";
import type { BasicIntroOffer } from "../../types/pricing";
import { config } from "../../services/configService";
import { getMockPaidPlans } from "../../services/pricingService";
import { getStripeClient } from "../../services/stripeClient";
import { publicProcedure, router } from "../trpc";

export const pricingRouter = router({
  plans: publicProcedure.query(async () => {
    if (config.mock.enabled) {
      return {
        plans: getMockPaidPlans(),
        introOffer: { status: "inactive" } satisfies BasicIntroOffer,
        annualIntroOffer: { status: "inactive" } satisfies BasicIntroOffer,
      };
    }
    const stripe = getStripeClient();
    if (!stripe || !config.stripe.secretKey) {
      return {
        plans: getMockPaidPlans(),
        annualIntroOffer: {
          status: config.stripe.basicIntroOffer.annualCouponId
            ? "unavailable"
            : "inactive",
        } satisfies BasicIntroOffer,
        introOffer: {
          status: Object.values(config.stripe.basicIntroOffer).some(Boolean)
            ? "unavailable"
            : "inactive",
        } satisfies BasicIntroOffer,
      };
    }
    try {
      return await getPublicPricingSnapshot(stripe);
    } catch (err) {
      console.error("Failed to load pricing from Stripe", err);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to load pricing",
      });
    }
  }),
});
