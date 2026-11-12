/** @jest-environment node */
import { createServer, type RequestListener, type Server } from "node:http";
import type { RuntimeHealthServer } from "../src/services/runtimeHealthServer";

const mockReady = { hasBeenReady: false };
jest.mock("../src/services/workerRegistry", () => ({
  hasBeenReady: () => mockReady.hasBeenReady,
  isEligible: () => false,
}));

import { config } from "../src/services/configService";
import { setupWebServer } from "../src/webserver";

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve(),
  );
  server = undefined;
});

async function serveApplication(): Promise<string> {
  config.mock.enabled = true;
  let application: RequestListener | undefined;
  const captured: Pick<RuntimeHealthServer, "activate"> = {
    activate(handler) {
      application = handler;
    },
  };
  await setupWebServer(captured);
  if (!application) throw new Error("The web server did not activate");
  const listening = createServer(application);
  server = listening;
  await new Promise<void>((resolve) => listening.listen(0, resolve));
  const address = listening.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

test("the web server's health route answers 503 before the first ready write, 200 after, 200 after ready turns false", async () => {
  const origin = await serveApplication();
  expect((await fetch(`${origin}/health`)).status).toBe(503);
  mockReady.hasBeenReady = true;
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  // The latch belongs to the registry, so nothing here can turn it off again.
  expect((await fetch(`${origin}/health`)).status).toBe(200);
  expect((await fetch(`${origin}/ready`)).status).toBe(404);
});
