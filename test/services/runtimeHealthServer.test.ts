/** @jest-environment node */
import { startRuntimeHealthServer } from "../../src/services/runtimeHealthServer";
import { createConnection } from "node:net";

const mockReady = { hasBeenReady: false, eligible: true };
jest.mock("../../src/services/workerRegistry", () => ({
  hasBeenReady: () => mockReady.hasBeenReady,
  isEligible: () => mockReady.eligible,
}));
beforeEach(() => {
  mockReady.hasBeenReady = false;
  mockReady.eligible = true;
});

function malformedRequest(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () =>
      socket.destroy(new Error("HTTP response timeout")),
    );
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("connect", () =>
      socket.write(
        "GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      ),
    );
  });
}

test("malformedRawTargetsCannotCrashTheListenerBeforeOrAfterActivation", async () => {
  const server = await startRuntimeHealthServer(0);
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const application = jest.fn((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  try {
    mockReady.hasBeenReady = true;
    expect(await malformedRequest(address.port)).toMatch(/^HTTP\/1.1 400 /);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    server.activate(application);
    expect(await malformedRequest(address.port)).toMatch(/^HTTP\/1.1 400 /);
    expect(application).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/health`)).status).toBe(200);
    expect((await fetch(`${origin}/application`)).status).toBe(204);
    expect(application).toHaveBeenCalledTimes(1);
  } finally {
    await server.close();
  }
});

test("503 before the first ready write, 200 after, 200 after ready turns false", async () => {
  const server = await startRuntimeHealthServer(0);
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const health = async () =>
    (await fetch(`http://127.0.0.1:${address.port}/health`)).status;
  try {
    expect(await health()).toBe(503);
    mockReady.hasBeenReady = true;
    expect(await health()).toBe(200);
    // The latch is the registry's; a later ready:false write leaves it set.
    mockReady.eligible = false;
    expect(await health()).toBe(200);
  } finally {
    await server.close();
  }
});

test("the ready route is gone and application paths answer 503 until activation", async () => {
  mockReady.hasBeenReady = true;
  const server = await startRuntimeHealthServer(0);
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    for (const path of ["/ready", "/trpc/start", "/api/billing/webhook"])
      expect((await fetch(`${origin}${path}`, { method: "POST" })).status).toBe(
        503,
      );
    server.activate((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    expect((await fetch(`${origin}/ready`)).status).toBe(204);
  } finally {
    await server.close();
  }
});
