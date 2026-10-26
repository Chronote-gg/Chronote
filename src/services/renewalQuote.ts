import { createHmac } from "node:crypto";
import { config } from "./configService";
import { readConsentToken, signConsentToken } from "../utils/consentToken";
import { renewalQuoteSchema, type RenewalQuote } from "../types/renewal";
const signingKey = () => {
  if (!config.server.sessionSecret)
    throw new Error("Renewal signing configuration is missing");
  return createHmac("sha256", config.server.sessionSecret)
    .update("chronote.billing.renewal.v1")
    .digest("hex");
};
export function signRenewalQuote(quote: unknown): string {
  return signConsentToken(renewalQuoteSchema.parse(quote), signingKey());
}
export function readRenewalQuote(
  token: string,
  now = Date.now(),
  binding?: Pick<RenewalQuote, "guildId" | "payerId">,
): RenewalQuote | undefined {
  if (!config.server.sessionSecret || token.split(".").length !== 2)
    return undefined;
  const quote = readConsentToken(
    token,
    signingKey(),
    (value: unknown): value is RenewalQuote =>
      renewalQuoteSchema.safeParse(value).success,
    now,
  );
  if (!quote || quote.issuedAt > now) return undefined;
  if (
    binding &&
    (quote.guildId !== binding.guildId || quote.payerId !== binding.payerId)
  )
    return undefined;
  return quote;
}

// Expired signed consent may identify an already persisted operation, never start one.
export function readRenewalRecoveryQuote(
  token: string,
  binding: Pick<RenewalQuote, "guildId" | "payerId">,
): RenewalQuote | undefined {
  if (!config.server.sessionSecret || token.split(".").length !== 2)
    return undefined;
  const quote = readConsentToken(
    token,
    signingKey(),
    (value: unknown): value is RenewalQuote =>
      renewalQuoteSchema.safeParse(value).success,
    0,
  );
  return quote &&
    quote.guildId === binding.guildId &&
    quote.payerId === binding.payerId
    ? quote
    : undefined;
}
