import { createServer, type RequestListener } from "node:http";
import { hasBeenReady } from "./workerRegistry";

/** One listener answers health from boot; application routes attach once the web server is built. */
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
      const healthy = hasBeenReady();
      response.writeHead(healthy ? 200 : 503, {
        "Content-Type": "application/json",
      });
      response.end(
        JSON.stringify({ status: healthy ? "healthy" : "starting" }),
      );
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
