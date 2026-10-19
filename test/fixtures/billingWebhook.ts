import express from "express";
import type http from "node:http";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import type { StripeClient } from "../../src/types/stripe";
import { registerBillingRoutes } from "../../src/api/billing";
export const createServer = (stripe: StripeClient) => {
  const app = express();
  app.use("/api/billing/webhook", express.raw({ type: "*/*" }));
  registerBillingRoutes(app, stripe);
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
};

export const postWebhook = async (baseUrl: string) => {
  const response = await fetch(`${baseUrl}/api/billing/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": "sig_test",
    },
    body: "{}",
  });
  return { statusCode: response.status, body: await response.text() };
};

export const closeServer = (server: http.Server) =>
  promisify(server.close.bind(server))();
