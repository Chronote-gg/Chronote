/** @jest-environment node */
import type { Request } from "express";
import {
  DeleteItemCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DiscordInstallStateStore,
  INSTALL_FLOW_TTL_MS,
  MAX_PENDING_INSTALL_FLOWS,
} from "../../src/services/discordInstallStateStore";
import {
  parseInstallAttribution,
  readInstallAttributionFromRequest,
  setInstallAttributionOnRequest,
} from "../../src/services/installAttributionService";

const request = (sessionID = "same-session") =>
  ({ sessionID, session: {} }) as Request;
const start = (store: DiscordInstallStateStore, req: Request) =>
  new Promise<string>((resolve, reject) =>
    store.store(req, (error, state: string) =>
      error ? reject(error) : resolve(state),
    ),
  );
const verify = (store: DiscordInstallStateStore, req: Request, state: string) =>
  new Promise<boolean>((resolve, reject) =>
    store.verify(req, state, (error, valid) =>
      error ? reject(error) : resolve(valid),
    ),
  );
const conditionalError = () =>
  Object.assign(new Error("condition failed"), {
    name: "ConditionalCheckFailedException",
  });

test("caps pending installs and reclaims slots after explicit expiry", async () => {
  const store = new DiscordInstallStateStore();
  await Promise.all(
    Array.from({ length: MAX_PENDING_INSTALL_FLOWS }, () =>
      start(store, request()),
    ),
  );
  await expect(start(store, request())).rejects.toThrow("Too many pending");
  const time = jest
    .spyOn(Date, "now")
    .mockReturnValue(Date.now() + INSTALL_FLOW_TTL_MS + 1000);
  try {
    await expect(start(store, request())).resolves.toMatch(/^install\./);
  } finally {
    time.mockRestore();
  }
});

test("concurrent consume has one winner and a different session cannot consume", async () => {
  const store = new DiscordInstallStateStore();
  const state = await start(store, request());
  await expect(verify(store, request("other-session"), state)).resolves.toBe(
    false,
  );
  const results = await Promise.all([
    verify(store, request(), state),
    verify(store, request(), state),
  ]);
  expect(results.sort()).toEqual([false, true]);
});

test("invalid nonce does not destroy the real pending flow", async () => {
  const store = new DiscordInstallStateStore();
  const state = await start(store, request());
  await expect(
    verify(store, request(), `${state.slice(0, -1)}!`),
  ).resolves.toBe(false);
  await expect(verify(store, request(), state)).resolves.toBe(true);
});

test("discarding one cancelled flow leaves other flow attribution intact", async () => {
  const store = new DiscordInstallStateStore();
  const a = request();
  setInstallAttributionOnRequest(
    a,
    parseInstallAttribution({ source: "github" }),
  );
  const stateA = await start(store, a);
  const stateB = await start(store, request());
  await store.discard(request(), stateB);
  const callback = request();
  await expect(verify(store, callback, stateA)).resolves.toBe(true);
  expect(readInstallAttributionFromRequest(callback)?.source).toBe("github");
  await expect(verify(store, request(), stateB)).resolves.toBe(false);
});

test("Dynamo reserves independent slots and atomically consumes once across store instances", async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const client = new DynamoDBClient({ region: "us-east-1" });
  const send = jest
    .spyOn(client, "send")
    .mockImplementation(async (command) => {
      if (command instanceof PutItemCommand) {
        expect(command.input.ConditionExpression).toBe(
          "attribute_not_exists(sid) OR expiresAt <= :now",
        );
        const row = unmarshall(command.input.Item!);
        const key = String(row.sid);
        if (rows.has(key)) throw conditionalError();
        rows.set(key, row);
        return {};
      }
      if (command instanceof DeleteItemCommand) {
        expect(command.input.ConditionExpression).toBe(
          "#state = :state AND expiresAt > :now",
        );
        expect(command.input.ReturnValues).toBe("ALL_OLD");
        const key = String(unmarshall(command.input.Key!).sid);
        const values = unmarshall(command.input.ExpressionAttributeValues!);
        const row = rows.get(key);
        if (
          !row ||
          row.state !== values[":state"] ||
          Number(row.expiresAt) <= Number(values[":now"])
        )
          throw conditionalError();
        rows.delete(key);
        return { Attributes: marshall(row, { removeUndefinedValues: true }) };
      }
      throw new Error("Unexpected Dynamo operation");
    });
  try {
    const one = new DiscordInstallStateStore(client);
    const two = new DiscordInstallStateStore(client);
    const [a, b] = await Promise.all([
      start(one, request()),
      start(two, request()),
    ]);
    expect(a).not.toBe(b);
    expect(rows.size).toBe(2);
    const results = await Promise.all([
      verify(one, request(), a),
      verify(two, request(), a),
    ]);
    expect(results.sort()).toEqual([false, true]);
    await expect(verify(two, request(), b)).resolves.toBe(true);
    expect(rows.size).toBe(0);
  } finally {
    send.mockRestore();
    client.destroy();
  }
});

test("Dynamo failures fail closed without authenticating", async () => {
  const client = new DynamoDBClient({ region: "us-east-1" });
  const send = jest
    .spyOn(client, "send")
    .mockRejectedValue(new Error("storage unavailable") as never);
  const store = new DiscordInstallStateStore(client);
  try {
    await expect(start(store, request())).rejects.toThrow(
      "storage unavailable",
    );
    await expect(
      verify(store, request(), `install.0.${"a".repeat(43)}`),
    ).rejects.toThrow("storage unavailable");
  } finally {
    send.mockRestore();
    client.destroy();
  }
});
