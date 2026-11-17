/** @jest-environment node */
import type { Server } from "node:http";

const mockReady = { hasBeenReady: false };
jest.mock("../src/services/workerRegistry", () => ({
  hasBeenReady: () => mockReady.hasBeenReady,
  isEligible: () => false,
}));

import { config } from "../src/services/configService";
import { serveWebApplication } from "./fixtures/webserver";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

test("the web server's health route answers 503 before the first ready write, 200 after, 200 after ready turns false", async () => {
  config.mock.enabled = true;
  const application = await serveWebApplication();
  server = application.server;
  const { origin } = application;
  expect((await fetch(`${origin}/health`)).status).toBe(503);
  mockReady.hasBeenReady = true;
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  // The latch belongs to the registry, so nothing here can turn it off again.
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  expect((await fetch(`${origin}/ready`)).status).toBe(404);
});
