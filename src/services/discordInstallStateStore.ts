import { createHash, randomBytes } from "node:crypto";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { Request } from "express";
import type {
  Metadata,
  StateStoreStoreCallback,
  StateStoreVerifyCallback,
} from "passport-oauth2";
import type { InstallAttribution } from "../types/db";
import { config } from "./configService";
import {
  readInstallAttributionFromRequest,
  setInstallAttributionOnRequest,
} from "./installAttributionService";

export const DISCORD_INSTALL_SESSION_KEY = "discordInstallBinding";
export const INSTALL_FLOW_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_INSTALL_FLOWS = 5;
const STATE_PATTERN = /^install\.([0-4])\.[A-Za-z0-9_-]{43}$/;

type InstallFlow = {
  sid: string;
  state: string;
  expiresAt: number;
  attribution?: InstallAttribution;
};
type InstallSession = Request["session"] & { discordInstallBinding?: string };
const conditionalFailure = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

export const isDiscordInstallState = (state: unknown): state is string =>
  typeof state === "string" && state.startsWith("install.");

export function readDiscordInstallBinding(req: Request) {
  if (!req.session || !req.sessionID) return undefined;
  return (
    (req.session as InstallSession).discordInstallBinding ??
    createHash("sha256").update(req.sessionID).digest("hex")
  );
}
export function restoreDiscordInstallBinding(
  req: Request,
  binding: string | undefined,
) {
  if (binding && req.session)
    (req.session as InstallSession).discordInstallBinding = binding;
}

// Each session has five independent slots in the existing SessionTable. Atomic
// reservation/consumption avoids whole-session last-writer-wins and replay races.
export class DiscordInstallStateStore {
  private readonly pending = new Map<string, InstallFlow>();
  private readonly tableName = `${config.database.tablePrefix ?? ""}SessionTable`;
  constructor(private readonly client?: DynamoDBClient) {}

  private async reserve(flow: InstallFlow): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    if (!this.client) {
      for (const [key, value] of this.pending)
        if (value.expiresAt <= now) this.pending.delete(key);
      if (this.pending.has(flow.sid)) return false;
      this.pending.set(flow.sid, flow);
      return true;
    }
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: marshall(flow, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(sid) OR expiresAt <= :now",
          ExpressionAttributeValues: marshall({ ":now": now }),
        }),
      );
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  private async consume(
    req: Request,
    state: string,
  ): Promise<InstallFlow | undefined> {
    const slot = STATE_PATTERN.exec(state)?.[1];
    const binding = readDiscordInstallBinding(req);
    if (!slot || !binding) return undefined;
    const sid = `discordInstall#${binding}#${slot}`;
    const now = Math.floor(Date.now() / 1000);
    if (!this.client) {
      const flow = this.pending.get(sid);
      if (!flow || flow.state !== state || flow.expiresAt <= now)
        return undefined;
      this.pending.delete(sid);
      return flow;
    }
    try {
      const result = await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: marshall({ sid }),
          ConditionExpression: "#state = :state AND expiresAt > :now",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: marshall({ ":state": state, ":now": now }),
          ReturnValues: "ALL_OLD",
        }),
      );
      return result.Attributes
        ? (unmarshall(result.Attributes) as InstallFlow)
        : undefined;
    } catch (error) {
      if (conditionalFailure(error)) return undefined;
      throw error;
    }
  }

  async discard(req: Request, state: unknown) {
    if (typeof state === "string") await this.consume(req, state);
  }

  store(req: Request, callback: StateStoreStoreCallback): void;
  store(req: Request, meta: Metadata, callback: StateStoreStoreCallback): void;
  store(
    req: Request,
    meta: Metadata | StateStoreStoreCallback,
    done?: StateStoreStoreCallback,
  ): void {
    const callback = typeof meta === "function" ? meta : done!;
    this.create(req).then(
      (state) => callback(null, state),
      (error: Error) => callback(error, undefined),
    );
  }

  private async create(req: Request) {
    if (!req.session || !req.sessionID)
      throw new Error("Discord install requires a session");
    // Deterministic for simultaneous starts in one session, then retained across
    // portal login regeneration without copying the rest of the session.
    const binding = readDiscordInstallBinding(req)!;
    restoreDiscordInstallBinding(req, binding);
    for (let slot = 0; slot < MAX_PENDING_INSTALL_FLOWS; slot++) {
      const state = `install.${slot}.${randomBytes(32).toString("base64url")}`;
      if (
        await this.reserve({
          sid: `discordInstall#${binding}#${slot}`,
          state,
          expiresAt: Math.floor((Date.now() + INSTALL_FLOW_TTL_MS) / 1000),
          attribution: readInstallAttributionFromRequest(req),
        })
      )
        return state;
    }
    throw new Error(
      "Too many pending Discord installs; finish a pending install or try again in ten minutes",
    );
  }

  verify(req: Request, state: string, callback: StateStoreVerifyCallback): void;
  verify(
    req: Request,
    state: string,
    meta: Metadata,
    callback: StateStoreVerifyCallback,
  ): void;
  verify(
    req: Request,
    state: string,
    meta: Metadata | StateStoreVerifyCallback,
    done?: StateStoreVerifyCallback,
  ): void {
    const callback = typeof meta === "function" ? meta : done!;
    this.consume(req, state).then(
      (flow) => {
        setInstallAttributionOnRequest(req, flow?.attribution);
        // Passport's callback accepts null on success; its declaration omits null.
        callback(null!, Boolean(flow), undefined);
      },
      (error: Error) => callback(error, false, undefined),
    );
  }
}

export const discordInstallStateStore = new DiscordInstallStateStore(
  config.mock.enabled
    ? undefined
    : new DynamoDBClient(
        config.database.useLocalDynamoDB
          ? {
              endpoint: "http://localhost:8000",
              region: "local",
              credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
            }
          : { region: config.storage.awsRegion },
      ),
);
