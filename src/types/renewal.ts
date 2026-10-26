import { RENEWAL_QUOTE_TTL_MS } from "../utils/renewalConstants";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
const snowflake = z.string().regex(/^\d{17,20}$/);
const nonce = z.string().uuid();
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
export const renewalTermsSchema = z
  .object({
    tier: z.enum(["basic", "pro"]),
    interval: z.enum(["month", "year"]),
    currency: z.string().regex(/^[a-z]{3}$/),
    unitAmount: z.number().int().nonnegative(),
    taxBehavior: z.enum(["exclusive", "inclusive"]),
    renewsAt: z.string().datetime(),
    discount: z
      .object({
        endsAt: z.string().datetime(),
        regularUnitAmount: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      !value.discount || value.discount.regularUnitAmount >= value.unitAmount,
  );
export type RenewalTerms = z.infer<typeof renewalTermsSchema>;
export const renewalQuoteSchema = z
  .object({
    purpose: z.literal("billing_renewal_v1"),
    nonce,
    guildId: snowflake,
    payerId: snowflake,
    subscriptionId: z.string().regex(/^sub_[a-zA-Z0-9]+$/),
    sourceRevision: z.string().min(1).nullable(),
    sourceFingerprint: fingerprint,
    terms: renewalTermsSchema,
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.expiresAt - value.issuedAt === RENEWAL_QUOTE_TTL_MS);
export type RenewalQuote = z.infer<typeof renewalQuoteSchema>;
export const renewalRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("confirm"),
      quoteToken: z.string().min(1).max(12000),
    })
    .strict(),
  z.object({ kind: z.literal("recover"), operationId: nonce }).strict(),
]);
export type RenewalRequest = z.infer<typeof renewalRequestSchema>;
const stripeRequestSchema = z.union([
  z
    .object({
      cancel_at_period_end: z.literal(false),
      proration_behavior: z.literal("none"),
    })
    .strict(),
  z
    .object({ cancel_at: z.literal(""), proration_behavior: z.literal("none") })
    .strict(),
]);
const operationBinding = {
  operationId: nonce,
  quoteNonce: nonce,
  guildId: snowflake,
  payerId: snowflake,
  mode: z.enum(["test", "live"]),
  subscriptionId: z.string().regex(/^sub_[a-zA-Z0-9]+$/),
  sourceRevision: z.string().min(1).nullable(),
  sourceFingerprint: fingerprint,
  invariantFingerprint: fingerprint,
  approvedTerms: renewalTermsSchema,
  stripeRequest: stripeRequestSchema,
  idempotencyKey: z.string().min(1).max(255),
  firstAttemptAt: z.number().int().nonnegative(),
  analyticsOptOut: z.boolean(),
  revision: z.string().min(1),
};
export const renewalOperationSchema = z
  .discriminatedUnion("state", [
    z.object({ ...operationBinding, state: z.literal("applying") }).strict(),
    z.object({ ...operationBinding, state: z.literal("verifying") }).strict(),
    z
      .object({
        ...operationBinding,
        state: z.literal("succeeded"),
        verifiedTerms: renewalTermsSchema,
      })
      .strict(),
    z
      .object({
        ...operationBinding,
        state: z.literal("rejected"),
        reason: z.enum([
          "source_changed",
          "authorization_changed",
          "provider_rejected",
        ]),
      })
      .strict(),
    z
      .object({
        ...operationBinding,
        state: z.literal("needs_review"),
        reason: z.enum([
          "provider_uncertain",
          "terms_changed",
          "persistence_failed",
          "retry_window_elapsed",
        ]),
      })
      .strict(),
  ])
  .refine((value) => value.operationId === value.quoteNonce);
export type RenewalOperation = z.infer<typeof renewalOperationSchema>;
export const renewalControlSchema = z
  .object({
    guildId: snowflake,
    operationId: nonce,
    revision: z.string().min(1),
  })
  .strict();
export type RenewalControl = z.infer<typeof renewalControlSchema>;
export const isRenewalComplete = (operation: RenewalOperation) =>
  operation.state === "succeeded" || operation.state === "rejected";
export const renewalBindingSchema = z
  .object(operationBinding)
  .omit({ revision: true });
export function assertRenewalOperationTransition(
  next: RenewalOperation,
  previous: RenewalOperation,
) {
  if (
    next.revision === previous.revision ||
    (previous.analyticsOptOut && !next.analyticsOptOut) ||
    !isDeepStrictEqual(
      renewalBindingSchema.omit({ analyticsOptOut: true }).parse(next),
      renewalBindingSchema.omit({ analyticsOptOut: true }).parse(previous),
    )
  )
    throw new Error("Renewal consent binding cannot change");
  if (
    isRenewalComplete(previous) ||
    (previous.state !== "applying" &&
      (next.state === "applying" || next.state === "rejected"))
  )
    throw new Error("Completed renewal operation cannot restart");
  if (
    next.state === "succeeded" &&
    !isDeepStrictEqual(next.verifiedTerms, next.approvedTerms)
  )
    throw new Error("Verified renewal terms differ from consent");
}
export type RenewalAction =
  | {
      kind: "ready";
      quoteToken: string;
      expiresAt: number;
      terms: RenewalTerms;
    }
  | {
      kind: "review_in_stripe";
      reason:
        | "unsupported_state"
        | "payment_problem"
        | "direct_unavailable"
        | "unverified_terms";
    }
  | { kind: "payer_required" }
  | { kind: "unavailable" };
export type RenewalState =
  | { kind: "payment_problem" }
  | {
      kind: "off";
      tier: RenewalTerms["tier"];
      endsAt: string;
      action: RenewalAction;
    }
  | { kind: "on"; terms: RenewalTerms }
  | { kind: "processing"; operationId: string; endsAt: string }
  | { kind: "needs_review"; operationId: string; knownEndsAt: string | null }
  | { kind: "terminal" }
  | { kind: "not_applicable" }
  | { kind: "unavailable"; knownEndsAt: string | null };
export type RenewalView = {
  state: RenewalState;
  canManageBilling: boolean;
  lifecycleAnalyticsEnabled: boolean;
};
export type RenewalResult =
  | { kind: "confirmed"; terms: RenewalTerms }
  | { kind: "changed" }
  | { kind: "processing"; operationId: string }
  | { kind: "needs_review"; operationId: string };

export function renewalOperationKey(guildId: string, operationId: string) {
  renewalControlSchema.parse({ guildId, operationId, revision: "key" });
  return `RENEWAL_OP#${guildId}#${operationId}`;
}
export function renewalControlKey(guildId: string) {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error("Invalid renewal guild ID");
  return `RENEWAL_CONTROL#${guildId}`;
}
