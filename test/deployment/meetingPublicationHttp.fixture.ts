import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import {
  discordEditorMessageSchema,
  type DiscordEditorMessage,
} from "../../src/services/discordMessageEditor";
function deferred() {
  let release: () => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}
async function requestEmbeds(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!payload || typeof payload !== "object" || !("embeds" in payload))
    throw new Error("Missing synthetic HTTP embeds");
  return discordEditorMessageSchema.shape.embeds.parse(payload.embeds);
}
/** Local HTTP responses exercise actual fetch transport and held provider lifetime. */
export async function publicationHttpFixture(input: {
  botId: string;
  guildId: string;
  channelId: string;
  messages: DiscordEditorMessage[];
}) {
  const remote = new Map(
    input.messages.map((message) => [message.id, structuredClone(message)]),
  );
  const writes: Array<{ method: string; id: string }> = [];
  let held:
    | {
        entered: ReturnType<typeof deferred>;
        tail: ReturnType<typeof deferred>;
      }
    | undefined;
  let nextId = 800000;
  let serverError: unknown;
  function getMessage(
    id: string,
    method: string,
  ): DiscordEditorMessage | undefined {
    if (method !== "POST") return remote.get(id);
    return discordEditorMessageSchema.parse({
      id: String(++nextId),
      channel_id: input.channelId,
      author: { id: input.botId, bot: true },
      content: "",
      embeds: [],
      components: [],
      attachments: [],
      flags: 0,
    });
  }
  async function mutate(
    request: IncomingMessage,
    response: ServerResponse,
    id: string,
  ): Promise<void> {
    const method = request.method ?? "GET";
    writes.push({ method, id });
    if (method === "DELETE") {
      remote.delete(id);
      response.statusCode = 204;
      response.end();
      return;
    }
    const embeds = await requestEmbeds(request);
    if (method === "PATCH" && held) {
      const wait = held;
      held = undefined;
      wait.entered.release();
      await wait.tail.promise;
    }
    const message = getMessage(id, method);
    if (!message) return sendJson(response, { code: 10008 }, 404);
    const after = discordEditorMessageSchema.parse({ ...message, embeds });
    remote.set(after.id, after);
    sendJson(response, after);
  }
  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path.endsWith("/users/@me"))
      return sendJson(response, { id: input.botId, bot: true });
    if (!path.includes("/messages"))
      return sendJson(response, {
        id: input.channelId,
        guild_id: input.guildId,
        type: 0,
      });
    const id = path.split("/").at(-1) ?? "";
    if (request.method !== "GET") return mutate(request, response, id);
    const message = remote.get(id);
    if (!message)
      return sendJson(
        response,
        { message: "Unknown Message", code: 10008 },
        404,
      );
    sendJson(response, message);
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      serverError = error;
      sendJson(response, { message: "Synthetic fixture failure" }, 500);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing local HTTP address");
  const base = "http://127.0.0.1:" + address.port;
  const fetchImpl: typeof fetch = (url, init) =>
    fetch(base + new URL(String(url)).pathname, init);
  return {
    remote,
    writes,
    fetchImpl,
    holdPatch() {
      held = { entered: deferred(), tail: deferred() };
      return held;
    },
    async send() {
      const response = await fetch(
        base + "/api/v10/channels/" + input.channelId + "/messages",
        { method: "POST", body: JSON.stringify({ embeds: [] }) },
      );
      return discordEditorMessageSchema.parse(await response.json()).id;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      if (serverError) throw serverError;
    },
  };
}
