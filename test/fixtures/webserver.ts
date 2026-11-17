import { createServer, type RequestListener } from "node:http";
import { setupWebServer } from "../../src/webserver";

export async function serveWebApplication() {
  let application: RequestListener | undefined;
  await setupWebServer({
    activate(handler) {
      application = handler;
    },
  });
  if (!application) throw new Error("The web server did not activate");
  const server = createServer(application);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing test port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
