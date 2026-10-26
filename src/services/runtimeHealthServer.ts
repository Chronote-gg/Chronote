import { createServer, type RequestListener } from "node:http";
import { getRuntimeReadiness } from "./runtimeLifecycleService";

/** One listener starts with liveness only; application routes attach after protection. */
export async function startRuntimeHealthServer(port: number) {
  let application: RequestListener | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "invalid_request_target" }));
      return;
    }
    if (path === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "healthy" }));
      return;
    }
    if (path === "/ready") {
      const proof = getRuntimeReadiness();
      const ready =
        proof &&
        proof.expiresAt > Date.now() / 1000 &&
        proof.dependenciesReady &&
        proof.cacheReady &&
        (proof.runtimeMode === "api" || proof.gatewayReady);
      response.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify({ status: ready ? "ready" : "warming" }));
      return;
    }
    if (application) {
      application(request, response);
      return;
    }
    response.writeHead(503, {
      "Content-Type": "application/json",
      "Retry-After": "5",
    });
    response.end(JSON.stringify({ status: "warming" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  return {
    server,
    activate(handler: RequestListener) {
      if (application)
        throw new Error("Application listener already installed");
      application = handler;
    },
    close: () => {
      closing ??= new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      return closing;
    },
  };
}
export type RuntimeHealthServer = Awaited<
  ReturnType<typeof startRuntimeHealthServer>
>;
