/** @jest-environment node */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
  jest,
} from "@jest/globals";
import express from "express";
import { TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { billingRouter } from "../../src/trpc/routers/billing";
import { getMockUser } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import { requireManageGuild } from "../../src/trpc/permissions";
import {
  readRenewalState,
  restoreRenewal,
} from "../../src/services/renewalReactivationService";
import { BillingActionError } from "../../src/services/billingActionError";
import Stripe from "stripe";
import type { Server } from "node:http";
jest.mock("../../src/trpc/permissions", () => ({
  ...jest.requireActual<typeof import("../../src/trpc/permissions")>(
    "../../src/trpc/permissions",
  ),
  requireManageGuild: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/renewalReactivationService", () => ({
  readRenewalState: jest.fn(),
  restoreRenewal: jest.fn(),
}));
jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: () => new Stripe("sk_test_fixture"),
}));
const originalMock = config.mock.enabled;
let server: Server;
let origin: string;
beforeAll(async () => {
  const app = express();
  app.use(
    "/trpc",
    createExpressMiddleware({
      router: billingRouter,
      createContext: ({ req, res }) => ({
        req,
        res,
        user: { ...getMockUser(), accessToken: "fixture-access" },
      }),
    }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Expected bound test port");
  origin = "http://127.0.0.1:" + address.port;
});
afterAll(async () => {
  config.mock.enabled = originalMock;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  config.mock.enabled = false;
  jest.clearAllMocks();
  jest.mocked(requireManageGuild).mockResolvedValue(undefined);
  jest.mocked(readRenewalState).mockResolvedValue({
    state: { kind: "not_applicable" },
    canManageBilling: false,
    lifecycleAnalyticsEnabled: false,
  });
  jest.mocked(restoreRenewal).mockResolvedValue({
    kind: "processing",
    operationId: "00000000-0000-4000-8000-000000000001",
  });
});
const client = (dnt?: string) =>
  createTRPCClient<typeof billingRouter>({
    links: [
      httpBatchLink({ url: origin + "/trpc", headers: dnt ? { dnt } : {} }),
    ],
  });
it("requires current server-management permission for both read and restore", async () => {
  jest
    .mocked(requireManageGuild)
    .mockRejectedValue(new TRPCError({ code: "FORBIDDEN" }));
  await expect(
    client().renewal.query({ serverId: "111111111111111111" }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  await expect(
    client().reactivateRenewal.mutate({
      serverId: "111111111111111111",
      request: { kind: "confirm", quoteToken: "untrusted" },
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
  expect(readRenewalState).not.toHaveBeenCalled();
  expect(restoreRenewal).not.toHaveBeenCalled();
});
it.each(["header", "input"])(
  "propagates %s opt-out into durable renewal execution",
  async (kind) => {
    const result = await client(
      kind === "header" ? "1" : undefined,
    ).reactivateRenewal.mutate({
      serverId: "111111111111111111",
      request: { kind: "confirm", quoteToken: "signed-consent" },
      analyticsOptOut: kind === "input",
    });
    expect(result.kind).toBe("processing");
    expect(restoreRenewal).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "111111111111111111",
        payerId: getMockUser().id,
        analyticsOptOut: true,
      }),
    );
  },
);
it("maps original-payer rejection and never trusts browser-supplied terms", async () => {
  jest
    .mocked(restoreRenewal)
    .mockRejectedValue(
      new BillingActionError(
        "FORBIDDEN",
        "Only the original payer can manage this server's Stripe billing",
      ),
    );
  await expect(
    client().reactivateRenewal.mutate({
      serverId: "111111111111111111",
      request: { kind: "confirm", quoteToken: "signed-consent" },
    }),
  ).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
});
it("rejects browser-supplied renewal terms before reaching the service", async () => {
  const result = await fetch(origin + "/trpc/reactivateRenewal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serverId: "111111111111111111",
      request: {
        kind: "confirm",
        quoteToken: "signed-consent",
        terms: { unitAmount: 1 },
      },
    }),
  });
  expect(result.status).toBe(400);
  expect(restoreRenewal).not.toHaveBeenCalled();
});
