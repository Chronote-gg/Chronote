/** @jest-environment node */
import { beforeEach, afterEach, it, expect } from "@jest/globals";
import { config } from "../../src/services/configService";
import { signConsentToken } from "../../src/utils/consentToken";
import {
  signRenewalQuote,
  readRenewalQuote,
} from "../../src/services/renewalQuote";
import { renewalQuote } from "../fixtures/renewal";
const originalSecret = config.server.sessionSecret;
beforeEach(() => {
  config.server.sessionSecret = "local-renewal-signing-test";
});
afterEach(() => {
  config.server.sessionSecret = originalSecret;
});
it("binds verified terms, server and payer through a signed round trip", () => {
  const token = signRenewalQuote(renewalQuote);
  expect(readRenewalQuote(token, 1000000)).toEqual(renewalQuote);
  expect(readRenewalQuote(token, 1299999)).toEqual(renewalQuote);
  expect(readRenewalQuote(token, 1300000)).toBeUndefined();
  expect(readRenewalQuote(token, 999999)).toBeUndefined();
});
it("rejects tampering, trailing fields and another consent purpose", () => {
  const token = signRenewalQuote(renewalQuote);
  expect(readRenewalQuote(token.replace(/^./, "z"), 1000000)).toBeUndefined();
  expect(readRenewalQuote(token + ".extra", 1000000)).toBeUndefined();
  expect(
    readRenewalQuote(
      signConsentToken(renewalQuote, config.server.sessionSecret),
      1000000,
    ),
  ).toBeUndefined();
});
it("rejects a signed token belonging to another server or payer", () => {
  const token = signRenewalQuote(renewalQuote);
  expect(
    readRenewalQuote(token, 1000000, {
      guildId: "333333333333333333",
      payerId: renewalQuote.payerId,
    }),
  ).toBeUndefined();
  expect(
    readRenewalQuote(token, 1000000, {
      guildId: renewalQuote.guildId,
      payerId: "333333333333333333",
    }),
  ).toBeUndefined();
});
it("refuses invalid terms, an extended lifetime and missing signing configuration", () => {
  expect(() =>
    signRenewalQuote({
      ...renewalQuote,
      terms: { ...renewalQuote.terms, unitAmount: -1 },
    }),
  ).toThrow();
  expect(() =>
    signRenewalQuote({ ...renewalQuote, expiresAt: 1300001 }),
  ).toThrow();
  expect(() =>
    signRenewalQuote({ ...renewalQuote, purpose: "other" }),
  ).toThrow();
  config.server.sessionSecret = "";
  expect(() => signRenewalQuote(renewalQuote)).toThrow();
  expect(readRenewalQuote("untrusted", 1000000)).toBeUndefined();
});
