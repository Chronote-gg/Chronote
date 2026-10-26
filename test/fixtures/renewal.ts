import { RENEWAL_QUOTE_TTL_MS } from "../../src/utils/renewalConstants";
import type { RenewalOperation, RenewalQuote } from "../../src/types/renewal";
import type { GuildSubscription } from "../../src/types/db";
export const renewalGuildId = "111111111111111111";
export const renewalPayerId = "222222222222222222";
export const renewalQuote: RenewalQuote = {
  purpose: "billing_renewal_v1",
  nonce: "00000000-0000-4000-8000-000000000001",
  guildId: renewalGuildId,
  payerId: renewalPayerId,
  subscriptionId: "sub_renewal",
  sourceRevision: "source-revision",
  sourceFingerprint: "a".repeat(64),
  issuedAt: 1000000,
  expiresAt: 1000000 + RENEWAL_QUOTE_TTL_MS,
  terms: {
    tier: "basic",
    interval: "year",
    currency: "usd",
    unitAmount: 10000,
    taxBehavior: "exclusive",
    renewsAt: "2027-10-12T12:00:00.000Z",
    discount: null,
  },
};
export const renewalSubscription: GuildSubscription = {
  guildId: renewalGuildId,
  tier: "basic",
  status: "active",
  subscriptionType: "stripe",
  startDate: "2026-10-12T12:00:00.000Z",
  stripeSubscriptionId: "sub_renewal",
  stripeSyncRevision: "source-revision",
};
export const renewalOperation: RenewalOperation = {
  operationId: renewalQuote.nonce,
  quoteNonce: renewalQuote.nonce,
  guildId: renewalGuildId,
  payerId: renewalPayerId,
  mode: "test",
  subscriptionId: "sub_renewal",
  sourceRevision: "source-revision",
  sourceFingerprint: "a".repeat(64),
  invariantFingerprint: "b".repeat(64),
  approvedTerms: renewalQuote.terms,
  stripeRequest: { cancel_at_period_end: false, proration_behavior: "none" },
  idempotencyKey: "renewal_test_00000000-0000-4000-8000-000000000001",
  firstAttemptAt: 1000000,
  analyticsOptOut: true,
  revision: "operation-revision",
  state: "applying",
};
