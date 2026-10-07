/** @jest-environment node */
import { expect, it, jest } from "@jest/globals";
import Stripe from "stripe";
import { getStripeClient } from "../../src/services/stripeClient";
import { config } from "../../src/services/configService";

jest.mock("stripe");

it("keeps the API contract pinned across Stripe SDK updates", () => {
  getStripeClient();
  expect(Stripe).toHaveBeenCalledWith(config.stripe.secretKey, {
    apiVersion: "2026-07-29.dahlia",
  });
});
