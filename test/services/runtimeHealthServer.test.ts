/** @jest-environment node */
import { startRuntimeHealthServer } from "../../src/services/runtimeHealthServer";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { createConnection } from "node:net";

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

test("healthOnlyListenerRejectsEveryApplicationPathUntilNativeConfirmation", async () => {
  const server = await startRuntimeHealthServer(0);
  const address = server.server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const identity = {
    kind: "ecs" as const,
    instanceId: "health-test",
    protocolVersion: 1 as const,
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/health",
    imageDigest: "digest",
    candidateId: "health",
  };
  let allowed = false;
  const service = createRuntimeProtectionService({
    identity,
    agentUri: "http://fixture",
    onUnsafe: jest.fn(),
    initialRetry: async () => {
      expect((await fetch(`${origin}/health`)).status).toBe(200);
      expect((await fetch(`${origin}/ready`)).status).toBe(503);
      for (const path of [
        "/trpc/start",
        "/api/billing/webhook",
        "/api/desktop",
        "/auth/discord",
        "/mcp",
      ])
        expect(
          (await fetch(`${origin}${path}`, { method: "POST" })).status,
        ).toBe(503);
      allowed = true;
    },
    request: async () =>
      allowed
        ? Response.json({
            protection: {
              TaskArn: identity.taskArn,
              ProtectionEnabled: true,
              ExpirationDate: new Date(Date.now() + 600000).toISOString(),
            },
          })
        : Response.json({
            failure: { Arn: identity.taskArn, Reason: "DEPLOYMENT_BLOCKED" },
          }),
  });
  try {
    await service.start();
    expect(service.isSafe()).toBe(true);
    const application = jest.fn((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    server.activate(application);
    expect((await fetch(`${origin}/application`)).status).toBe(204);
    expect(application).toHaveBeenCalledTimes(1);
    expect(server.server.address()).toEqual(address);
  } finally {
    service.stop();
    await server.close();
  }
});
