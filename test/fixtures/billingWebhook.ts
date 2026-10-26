import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { registerBillingRoutes } from "../../src/api/billing";
import type { StripeClient, StripeEvent } from "../../src/types/stripe";
export const guildId = "111111111111111111";
export const basicPrice = {
  id: "price_basic",
  lookup_key: "chronote_basic_monthly",
};
export const createServer = (stripe: StripeClient | null) => {
  const app = express();
  app.use("/api/billing/webhook", express.raw({ type: "*/*" }));
  registerBillingRoutes(app, stripe);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};
export const postWebhook = async (
  baseUrl: string,
  payload = "{}",
  signature = "sig_test",
) => {
  const response = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    body: payload,
  });
  return { statusCode: response.status, body: await response.text() };
};
export const closeServer = (server: Server) =>
  promisify(server.close.bind(server))();
const subscriptionFields = {
  id: "sub_basic",
  latest_invoice: "in_current",
  metadata: { guild_id: guildId },
  start_date: 1_767_225_600,
  ended_at: null,
  customer: "cus_basic",
  default_payment_method: "pm_basic",
  livemode: false,
  items: { data: [{ price: basicPrice, current_period_end: 1_769_904_000 }] },
};
export const subscriptionEvent = (status: string, eventId: string) =>
  ({
    id: eventId,
    type: "customer.subscription.updated",
    data: { object: { ...structuredClone(subscriptionFields), status } },
  }) as unknown as StripeEvent;
export const activeStripeSubscription = {
  ...structuredClone(subscriptionFields),
  status: "active",
  created: 1_767_225_600,
};
