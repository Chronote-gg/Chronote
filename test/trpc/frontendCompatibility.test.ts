/** @jest-environment node */
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import { TRPCError } from "@trpc/server";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { router } from "../../src/trpc/trpc";
import { billingRouter } from "../../src/trpc/routers/billing";
import { firstMeeting } from "../../src/trpc/routers/firstMeeting";
import { config } from "../../src/services/configService";
import { getMockUser } from "../../src/repositories/mockStore";
import { requireManageGuild } from "../../src/trpc/permissions";
import { ensureUserInGuild } from "../../src/services/guildAccessService";
import { getFirstMeetingState } from "../../src/services/firstMeetingService";
import type { FirstMeetingState } from "../../src/types/firstMeeting";
import {
  billingRequests,
  firstMeetingRequests,
  firstMeetingTarget,
} from "../fixtures/frontendApiContracts";
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/services/stripeClient", () => ({
  getStripeClient: () => ({}),
}));
jest.mock("../../src/services/pricingService", () => ({
  resolvePaidPlanPriceId: async () => "price_local",
}));
jest.mock("../../src/services/billingService", () => ({
  ...jest.requireActual("../../src/services/billingService"),
  getBillingSnapshot: async () => ({ billingEnabled: true, tier: "basic" }),
  createCheckoutSession: async ({
    interval,
    offerChoice,
  }: {
    interval: string;
    offerChoice: string;
  }) => `https://checkout.invalid/${interval}/${offerChoice}`,
  createPortalSession: async () => "https://billing.invalid/portal",
}));
jest.mock("../../src/repositories/subscriptionRepository", () => ({
  getSubscriptionRepository: () => ({ get: async () => undefined }),
}));
jest.mock("../../src/repositories/billingChangeRepository", () => ({
  getBillingChangeRepository: () => ({
    getControl: async () => undefined,
    getOperation: async () => undefined,
  }),
}));
jest.mock("../../src/repositories/renewalReactivationRepository", () => ({
  getRenewalReactivationRepository: () => ({
    getOperation: async () => undefined,
  }),
}));
jest.mock("../../src/trpc/permissions", () => ({
  ...jest.requireActual("../../src/trpc/permissions"),
  requireManageGuild: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/guildAccessService", () => ({
  ensureUserInGuild: jest.fn(async () => true),
  ensureBotInGuild: jest.fn(async () => true),
}));
jest.mock("../../src/services/firstMeetingService", () => ({
  getFirstMeetingState: jest.fn(),
}));
const previous = { ...config.stripe };
const previousMock = config.mock.enabled;
let server: Server;
let origin: string;
let signedIn = true;
beforeAll(async () => {
  const app = express();
  app.use(
    "/trpc",
    createExpressMiddleware({
      router: router({
        billing: billingRouter,
        meetings: router({ firstMeeting }),
      }),
      createContext: ({ req, res }) => ({
        req,
        res,
        user: signedIn ? getMockUser() : null,
      }),
    }),
  );
  server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local HTTP port");
  origin = `http://127.0.0.1:${address.port}/trpc/`;
});
afterAll(async () => {
  Object.assign(config.stripe, previous);
  config.mock.enabled = previousMock;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});
beforeEach(() => {
  config.mock.enabled = false;
  Object.assign(config.stripe, {
    subscriptionTransitionsEnabled: false,
    renewalGraceEnabled: false,
    introOfferLedgerEnabled: false,
    renewalReactivationEnabled: false,
  });
  signedIn = true;
  jest.mocked(requireManageGuild).mockResolvedValue(undefined);
  jest.mocked(ensureUserInGuild).mockResolvedValue(true);
});
async function request(method: string, path: string, input: unknown) {
  const batch = JSON.stringify({ "0": input });
  const response = await fetch(
    origin +
      path +
      "?batch=1" +
      (method === "GET" ? "&input=" + encodeURIComponent(batch) : ""),
    {
      method,
      headers: { "content-type": "application/json" },
      ...(method === "POST" ? { body: batch } : {}),
    },
  );
  return { status: response.status, body: await response.json() };
}
test.each(billingRequests)(
  "$client literal $method $path survives candidate backend publication",
  async ({ method, path, input, expected }) => {
    const result = await request(method, path, input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject([{ result: { data: expected } }]);
  },
);
test("frozen cached-client HTTP contracts remain usable against the candidate backend", async () => {
  for (const fixture of billingRequests) {
    const result = await request(fixture.method, fixture.path, fixture.input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject([{ result: { data: fixture.expected } }]);
  }
});
test.each([
  "billing.me",
  "billing.checkout",
  "billing.portal",
  "billing.renewal",
])("%s preserves signed-in and server-management access", async (path) => {
  const method = ["billing.checkout", "billing.portal"].includes(path)
    ? "POST"
    : "GET";
  const input = { serverId: "111111111111111111", tier: "basic" };
  signedIn = false;
  expect((await request(method, path, input)).body).toMatchObject([
    { error: { data: { code: "UNAUTHORIZED" } } },
  ]);
  signedIn = true;
  jest
    .mocked(requireManageGuild)
    .mockRejectedValue(new TRPCError({ code: "FORBIDDEN" }));
  expect((await request(method, path, input)).body).toMatchObject([
    { error: { data: { code: "FORBIDDEN" } } },
  ]);
});
test("current plan transition request stays disabled over HTTP", async () => {
  const result = await request("POST", "billing.prepareChange", {
    serverId: "111111111111111111",
    selection: { tier: "pro", interval: "month", expectedOffer: "none" },
  });
  expect(result.status).toBe(400);
  expect(result.body).toMatchObject([
    {
      error: {
        message: "Plan changes are not available yet.",
        data: { code: "BAD_REQUEST" },
      },
    },
  ]);
});
const states: FirstMeetingState[] = [
  { kind: "guide" },
  ...(["recording", "processing", "ready", "saved"] as const).map((kind) => ({
    kind,
    meeting: firstMeetingTarget,
  })),
  {
    kind: "delivery_attention",
    delivery: "partial",
    meeting: firstMeetingTarget,
  },
  { kind: "attention", reason: "status_unknown", meeting: firstMeetingTarget },
];
test.each(states)(
  "current firstMeeting preserves $kind response for both literal inputs",
  async (state) => {
    jest.mocked(getFirstMeetingState).mockResolvedValue(state);
    for (const input of firstMeetingRequests) {
      const result = await request("GET", "meetings.firstMeeting", input);
      expect(result.status).toBe(200);
      expect(result.body).toEqual([{ result: { data: state } }]);
    }
  },
);
test("current firstMeeting keeps member access and rejects malformed history", async () => {
  jest.mocked(ensureUserInGuild).mockResolvedValue(false);
  expect(
    (await request("GET", "meetings.firstMeeting", firstMeetingRequests[0]))
      .status,
  ).toBe(403);
  jest.mocked(ensureUserInGuild).mockResolvedValue(true);
  expect(
    (
      await request("GET", "meetings.firstMeeting", {
        ...firstMeetingRequests[0],
        historyId: "internal-id",
      })
    ).status,
  ).toBe(400);
});
