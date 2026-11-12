import { AsyncLocalStorage } from "node:async_hooks";
import type * as DiscordJs from "discord.js";
import type { ClientOptions } from "discord.js";
import { Response as UndiciResponse } from "undici";
import type { WorkerGate } from "./world";

export type FakeMember = { id: string; username: string; bot?: boolean };
type FakeChannel = {
  id: string;
  guildId: string;
  name: string;
  kind: "text" | "voice";
};
type FakeGuild = {
  id: string;
  name: string;
  channels: Map<string, FakeChannel>;
  members: Map<string, FakeMember>;
};
export type RestCall = { method: string; path: string; body: unknown };
/** What an interaction produced on REST; filled in once workers handle commands. */
export type FakeInteraction = { id: string; responses: RestCall[] };
type FakeMessage = {
  id: string;
  channel_id: string;
  content: string;
  embeds: unknown[];
  components: unknown[];
  timestamp: string;
};

const DISCORD_API_ORIGIN = "https://discord.com";
const API_PATH_PREFIX = /^\/api(\/v\d+)?/;
const CHANNEL_TYPE = { text: 0, voice: 2 } as const;
const UNKNOWN_MESSAGE_CODE = 10008;
const ALREADY_ACKNOWLEDGED_CODE = 40060;
const BAD_REQUEST = 400;
const FIRST_MESSAGE_SNOWFLAKE = 1_300_000_000_000_000_000n;
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const MESSAGE_METHODS = new Set(["GET", "PATCH", "DELETE"]);

type RestReply = { status: number; payload?: unknown };
const NO_CONTENT: RestReply = { status: 204 };
const JSON_HEADERS = { "content-type": "application/json" };

function json(payload: unknown, status = 200): RestReply {
  return { status, payload };
}

function responseInit(reply: RestReply) {
  // A bodiless reply carries no content type, or the REST client tries to parse it as JSON.
  if (reply.payload === undefined)
    return { body: null, init: { status: reply.status } };
  return {
    body: JSON.stringify(reply.payload),
    init: { status: reply.status, headers: JSON_HEADERS },
  };
}

function parseBody(body: unknown): unknown {
  return typeof body === "string" ? JSON.parse(body) : body;
}

export function userPayload(member: FakeMember) {
  return {
    id: member.id,
    username: member.username,
    discriminator: "0",
    global_name: null,
    avatar: null,
    bot: member.bot ?? false,
  };
}

/** Runs before a request is answered; a returned status fails that request with it, a throw fails it as a network error. */
type RequestHook = (call: RestCall) => number | void | Promise<number | void>;

/** Discord REST as one in-memory handler shared by every worker's client and by global fetch. */
export class FakeRest {
  private readonly calls: RestCall[] = [];
  private readonly failures: { status: number; remaining: number }[] = [];
  private readonly postHooks: ((call: RestCall) => void | Promise<void>)[] = [];
  private readonly requestHooks: RequestHook[] = [];
  /** Interactions already given their one callback, as Discord allows. */
  private readonly acknowledged = new Set<string>();
  /** Second callbacks refused so far. */
  rejectedCallbacks = 0;
  readonly messages = new Map<string, FakeMessage>();
  /** Interaction responses edited through the webhook route, keyed by interaction token. */
  private readonly originals = new Map<string, FakeMessage>();
  private nextMessageId = FIRST_MESSAGE_SNOWFLAKE;

  constructor(private readonly discord: FakeDiscord) {}

  requests(): RestCall[] {
    return [...this.calls];
  }

  posts(): RestCall[] {
    return this.calls.filter((call) => call.method === "POST");
  }

  /** The next `times` mutating requests (POST, PATCH, PUT, DELETE) fail with `status`; reads are unaffected. */
  failNext(status: number, times = 1): void {
    this.failures.push({ status, remaining: times });
  }

  /** Runs before every request is answered, whatever its method; see `RequestHook`. */
  onRequest(hook: RequestHook): void {
    this.requestHooks.push(hook);
  }

  /** Runs before each POST is answered; a hook that awaits holds the request. */
  onPost(hook: (call: RestCall) => void | Promise<void>): void {
    this.postHooks.push(hook);
  }

  async handle(method: string, url: string, body: unknown): Promise<RestReply> {
    this.discord.workers.getStore()?.assertAlive();
    const path = new URL(url).pathname.replace(API_PATH_PREFIX, "");
    const call = { method, path, body: parseBody(body) };
    const answer = this.route(call);
    this.calls.push(call);
    for (const hook of this.requestHooks) {
      const status = await hook(call);
      if (status !== undefined)
        return json({ message: "Scripted failure", code: 0 }, status);
    }
    if (method === "POST") for (const hook of this.postHooks) await hook(call);
    if (MUTATING_METHODS.has(method)) {
      const failure = this.failures[0];
      if (failure) {
        failure.remaining -= 1;
        if (failure.remaining === 0) this.failures.shift();
        return json({ message: "Scripted failure", code: 0 }, failure.status);
      }
    }
    return answer();
  }

  /** Resolves only the routes this fake implements; anything else throws so a scenario cannot pass on a guess. */
  private route({ method, path, body }: RestCall): () => RestReply {
    const segments = path.split("/").slice(1);
    const [resource, id, sub, messageId] = segments;
    const shape = `${method} ${segments.length}`;
    if (resource === "users" && id === "@me" && shape === "GET 2")
      return () => json(userPayload(this.discord.bot));
    if (
      resource === "interactions" &&
      segments[3] === "callback" &&
      shape === "POST 4"
    )
      return () => this.callbackReply(id);
    if (resource === "applications" && sub === "commands" && shape === "PUT 3")
      return () => json([]);
    if (resource === "guilds" && sub === "members" && shape === "PATCH 4")
      return () =>
        json({ user: userPayload(this.discord.bot), roles: [], flags: 0 });
    if (resource === "webhooks" && sub) {
      if (shape === "POST 3")
        return () => json(this.create(`interaction:${sub}`, body));
      if (segments[3] === "messages" && segments.length === 5)
        return () => this.originalReply(method, sub, body);
    }
    if (resource === "channels" && id && shape === "GET 2")
      return () => this.channelReply(id);
    if (resource === "channels" && id && sub === "messages") {
      if (shape === "GET 3") return () => this.listReply(id);
      if (shape === "POST 3") return () => json(this.create(id, body));
      if (messageId && segments.length === 4 && MESSAGE_METHODS.has(method))
        return () => this.messageReply(method, messageId, body);
    }
    throw new Error(`FakeRest does not implement ${method} ${path}`);
  }

  /** Discord takes one callback per interaction and refuses any later one. */
  private callbackReply(interactionId: string): RestReply {
    if (this.acknowledged.has(interactionId)) {
      this.rejectedCallbacks += 1;
      return json(
        {
          message: "Interaction has already been acknowledged.",
          code: ALREADY_ACKNOWLEDGED_CODE,
        },
        BAD_REQUEST,
      );
    }
    this.acknowledged.add(interactionId);
    return NO_CONTENT;
  }

  /** The interaction's original response, as a deferred reply's edits leave it. */
  private originalReply(
    method: string,
    token: string,
    body: unknown,
  ): RestReply {
    if (method === "DELETE") {
      this.originals.delete(token);
      return NO_CONTENT;
    }
    const existing = this.originals.get(token);
    const message =
      existing ?? this.createMessage(`interaction:${token}`, body);
    if (existing && method === "PATCH")
      Object.assign(existing, this.messageFields(body, existing));
    this.originals.set(token, message);
    return json(this.messagePayload(message));
  }

  /** A message as Discord delivers it to a component interaction. */
  messageData(messageId: string) {
    const message = this.messages.get(messageId);
    if (!message) throw new Error(`Unknown scenario message ${messageId}`);
    return this.messagePayload(message);
  }

  private channelReply(id: string): RestReply {
    const channel = this.discord.channel(id);
    return channel
      ? json(this.discord.channelPayload(channel))
      : json({ message: "Unknown Channel", code: 0 }, 404);
  }

  private listReply(channelId: string): RestReply {
    return json(
      [...this.messages.values()]
        .filter((message) => message.channel_id === channelId)
        .reverse()
        .map((message) => this.messagePayload(message)),
    );
  }

  private messageReply(
    method: string,
    messageId: string,
    body: unknown,
  ): RestReply {
    const message = this.messages.get(messageId);
    if (!message)
      return json(
        { message: "Unknown Message", code: UNKNOWN_MESSAGE_CODE },
        404,
      );
    if (method === "DELETE") {
      this.messages.delete(messageId);
      return NO_CONTENT;
    }
    if (method === "PATCH")
      Object.assign(message, this.messageFields(body, message));
    return json(this.messagePayload(message));
  }
  private messageFields(body: unknown, base: Omit<FakeMessage, "id">) {
    const fields = body && typeof body === "object" ? body : {};
    return {
      content:
        "content" in fields && typeof fields.content === "string"
          ? fields.content
          : base.content,
      embeds:
        "embeds" in fields && Array.isArray(fields.embeds)
          ? fields.embeds
          : base.embeds,
      components:
        "components" in fields && Array.isArray(fields.components)
          ? fields.components
          : base.components,
    };
  }

  private create(channelId: string, body: unknown) {
    return this.messagePayload(this.createMessage(channelId, body));
  }

  private createMessage(channelId: string, body: unknown): FakeMessage {
    const base = {
      channel_id: channelId,
      content: "",
      embeds: [],
      components: [],
      timestamp: new Date().toISOString(),
    };
    const message = {
      ...base,
      ...this.messageFields(body, base),
      id: String(this.nextMessageId++),
    };
    this.messages.set(message.id, message);
    return message;
  }

  private messagePayload(message: FakeMessage) {
    return {
      ...message,
      type: 0,
      author: userPayload(this.discord.bot),
      attachments: [],
      mentions: [],
      mention_roles: [],
      mention_everyone: false,
      pinned: false,
      tts: false,
      edited_timestamp: null,
      flags: 0,
    };
  }
}

/** Guilds, channels and members every worker's gateway client sees on login. */
export class FakeDiscord {
  readonly bot: FakeMember = {
    id: "100000000000000001",
    username: "Chronote",
    bot: true,
  };
  readonly guilds = new Map<string, FakeGuild>();
  readonly rest = new FakeRest(this);
  /** The worker whose code is running; REST from a killed worker throws, REST with no worker (the test) passes. */
  readonly workers = new AsyncLocalStorage<WorkerGate>();

  addGuild(id: string, name = "Scenario Guild"): void {
    this.guilds.set(id, { id, name, channels: new Map(), members: new Map() });
  }

  addChannel(channel: FakeChannel): void {
    this.guild(channel.guildId).channels.set(channel.id, channel);
  }

  addMember(guildId: string, member: FakeMember): void {
    this.guild(guildId).members.set(member.id, member);
  }

  channel(id: string): FakeChannel | undefined {
    for (const guild of this.guilds.values()) {
      const channel = guild.channels.get(id);
      if (channel) return channel;
    }
    return undefined;
  }

  channelPayload(channel: FakeChannel) {
    return {
      id: channel.id,
      guild_id: channel.guildId,
      name: channel.name,
      type: CHANNEL_TYPE[channel.kind],
    };
  }

  /** Routes `https://discord.com/api` through the REST fake and everything else to `fallback`. */
  fetch(fallback: typeof fetch): typeof fetch {
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith(DISCORD_API_ORIGIN + "/api"))
        return fallback(input, init);
      const { body, init: reply } = responseInit(
        await this.rest.handle(init?.method ?? "GET", url, init?.body),
      );
      return new Response(body, reply);
    };
  }

  private guild(id: string): FakeGuild {
    const guild = this.guilds.get(id);
    if (!guild) throw new Error(`Unknown scenario guild ${id}`);
    return guild;
  }
}

/**
 * A discord.js Client whose login builds the gateway caches from FakeDiscord
 * and emits ClientReady without a socket, and whose REST goes to FakeRest.
 * Guild, channel and member objects are constructed the way
 * test/fixtures/meetingStart.ts builds them.
 */
export function createFakeClientClass(
  djs: typeof DiscordJs,
  discord: FakeDiscord,
  gate: WorkerGate,
) {
  return class ScenarioClient extends djs.Client {
    constructor(options: ClientOptions) {
      super({
        ...options,
        rest: {
          ...options.rest,
          makeRequest: async (url, init) => {
            gate.assertAlive();
            const { body, init: reply } = responseInit(
              await discord.rest.handle(init.method ?? "GET", url, init.body),
            );
            return new UndiciResponse(body, reply);
          },
        },
      });
    }

    override async login(token = "scenario-token"): Promise<string> {
      gate.assertAlive();
      this.token = token;
      this.rest.setToken(token);
      this.user = Reflect.construct(djs.ClientUser, [
        this,
        userPayload(discord.bot),
      ]);
      for (const seed of discord.guilds.values()) this.cacheGuild(seed);
      this.ws.status = djs.Status.Ready;
      Reflect.set(this, "readyTimestamp", Date.now());
      if (this.isReady()) this.emit(djs.Events.ClientReady, this);
      return token;
    }

    private cacheGuild(seed: FakeGuild): void {
      const guild: DiscordJs.Guild = Reflect.construct(djs.Guild, [
        this,
        { id: seed.id, name: seed.name },
      ]);
      this.guilds.cache.set(guild.id, guild);
      // The bot's permission checks resolve through @everyone; scenarios grant it everything.
      const everyone: DiscordJs.Role = Reflect.construct(djs.Role, [
        this,
        {
          id: guild.id,
          name: "@everyone",
          permissions: String(djs.PermissionFlagsBits.Administrator),
          position: 0,
          color: 0,
          hoist: false,
          managed: false,
          mentionable: false,
          flags: 0,
        },
        guild,
      ]);
      guild.roles.cache.set(everyone.id, everyone);
      for (const channel of seed.channels.values()) {
        const created: DiscordJs.TextChannel | DiscordJs.VoiceChannel =
          Reflect.construct(
            channel.kind === "voice" ? djs.VoiceChannel : djs.TextChannel,
            [guild, discord.channelPayload(channel), this],
          );
        guild.channels.cache.set(created.id, created);
        this.channels.cache.set(created.id, created);
      }
      for (const member of [discord.bot, ...seed.members.values()])
        guild.members.cache.set(
          member.id,
          Reflect.construct(djs.GuildMember, [
            this,
            { user: userPayload(member), roles: [] },
            guild,
          ]),
        );
    }
  };
}
