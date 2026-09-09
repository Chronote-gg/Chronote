/** @jest-environment node */
import type { Request, Response } from "express";
import { billingRouter } from "../../src/trpc/routers/billing";
import { config } from "../../src/services/configService";
import { getMockUser } from "../../src/repositories/mockStore";
import {
  BillingActionError,
  createCheckoutSession,
  createPortalSession,
} from "../../src/services/billingService";

jest.mock("../../src/services/billingService", () => ({
  ...jest.requireActual("../../src/services/billingService"),
  createCheckoutSession: jest.fn(),
  createPortalSession: jest.fn(),
}));
jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: () => ({}),
}));
jest.mock("../../src/services/pricingService", () => ({
  resolvePaidPlanPriceId: async () => "price_pro",
}));
jest.mock("../../src/trpc/permissions", () => ({
  ...jest.requireActual("../../src/trpc/permissions"),
  requireManageGuild: jest.fn(async () => undefined),
}));

const originalMock = config.mock.enabled;
beforeEach(() => {
  config.mock.enabled = false;
  jest.clearAllMocks();
});
afterAll(() => {
  config.mock.enabled = originalMock;
});
const caller = () =>
  billingRouter.createCaller({
    req: { session: {} } as Request,
    res: {} as Response,
    user: { ...getMockUser(), accessToken: "fixture-token" },
  });

test("checkout preserves a safe payer denial", async () => {
  jest
    .mocked(createCheckoutSession)
    .mockRejectedValue(
      new BillingActionError(
        "FORBIDDEN",
        "Only the original payer can manage this server's Stripe billing",
      ),
    );
  await expect(
    caller().checkout({ serverId: "111111111111111111", tier: "pro" }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringContaining("original payer"),
  });
});

test("checkout explains a recoverable subscription state", async () => {
  jest
    .mocked(createCheckoutSession)
    .mockRejectedValue(
      new BillingActionError(
        "BAD_REQUEST",
        "Resolve the existing subscription in billing management before changing plans",
      ),
    );
  await expect(
    caller().checkout({ serverId: "111111111111111111", tier: "pro" }),
  ).rejects.toMatchObject({
    code: "BAD_REQUEST",
    message: expect.stringContaining("billing management"),
  });
});

test("portal preserves a safe payer denial", async () => {
  jest
    .mocked(createPortalSession)
    .mockRejectedValue(
      new BillingActionError(
        "FORBIDDEN",
        "Only the original payer can manage this server's Stripe billing",
      ),
    );
  await expect(
    caller().portal({ serverId: "111111111111111111" }),
  ).rejects.toMatchObject({
    code: "FORBIDDEN",
    message: expect.stringContaining("original payer"),
  });
});

test("unexpected provider details remain hidden", async () => {
  jest
    .mocked(createCheckoutSession)
    .mockRejectedValue(new Error("private provider detail"));
  await expect(
    caller().checkout({ serverId: "111111111111111111", tier: "pro" }),
  ).rejects.toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Unable to create checkout session",
  });
});
