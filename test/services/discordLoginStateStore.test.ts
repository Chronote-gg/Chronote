/** @jest-environment node */
import type { Request } from "express";
import {
  DiscordLoginStateStore,
  setDiscordLoginIntent,
  readDiscordLoginIntent,
} from "../../src/services/discordLoginStateStore";
import { resolveRedirectTarget } from "../../src/services/oauthRedirectService";

const request = (sessionID = "fixture-session") =>
  ({ sessionID, session: {} }) as Request;
const start = (store: DiscordLoginStateStore, req: Request, target: string) => {
  setDiscordLoginIntent(req, {
    returnTo: target,
    prompt: "none",
    recoveryId: "fixture-recovery",
  });
  return new Promise<string>((resolve, reject) =>
    store.store(req, (error, state: string) =>
      error ? reject(error) : resolve(state),
    ),
  );
};
const verify = (store: DiscordLoginStateStore, req: Request, state: string) =>
  new Promise<boolean>((resolve, reject) =>
    store.verify(req, state, (error, valid) =>
      error ? reject(error) : resolve(valid),
    ),
  );

test("reverse-order callbacks keep their own return targets and consume state once", async () => {
  const store = new DiscordLoginStateStore();
  const a = await start(
    store,
    request(),
    "https://example.test/portal/meetings?scope=personal#notes",
  );
  const b = await start(
    store,
    request(),
    "https://example.test/portal/settings",
  );
  const callbackB = request();
  expect(await verify(store, callbackB, b)).toBe(true);
  expect(readDiscordLoginIntent(callbackB)?.returnTo).toBe(
    "https://example.test/portal/settings",
  );
  const callbackA = request();
  expect(await verify(store, callbackA, a)).toBe(true);
  expect(readDiscordLoginIntent(callbackA)?.returnTo).toContain(
    "scope=personal#notes",
  );
  expect(await verify(store, request(), a)).toBe(false);
});
test("a different session and invalid nonce cannot consume a pending login", async () => {
  const store = new DiscordLoginStateStore();
  const state = await start(store, request(), "https://example.test/portal");
  expect(await verify(store, request("wrong-session"), state)).toBe(false);
  expect(await verify(store, request(), state + "invalid")).toBe(false);
  const result = await Promise.all([
    verify(store, request(), state),
    verify(store, request(), state),
  ]);
  expect(result.sort()).toEqual([false, true]);
});
test("denial consumes only validated state and recovers the bound intent", async () => {
  const store = new DiscordLoginStateStore();
  const state = await start(store, request(), "https://example.test/portal");
  expect(await store.consumeFailure(request("wrong"), state)).toBeUndefined();
  expect(await store.consumeFailure(request(), state)).toEqual({
    returnTo: "https://example.test/portal",
    prompt: "none",
    recoveryId: "fixture-recovery",
  });
  expect(await store.consumeFailure(request(), state)).toBeUndefined();
});
test("explicit expiry is enforced without waiting for table TTL deletion", async () => {
  const store = new DiscordLoginStateStore();
  const state = await start(store, request(), "https://example.test/portal");
  const now = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
  try {
    expect(await verify(store, request(), state)).toBe(false);
  } finally {
    now.mockRestore();
  }
});
test("return targets reject a different origin and normalized backslash escape", () => {
  expect(
    resolveRedirectTarget("https://other.test/portal", "https://example.test"),
  ).toBeUndefined();
  expect(
    resolveRedirectTarget("/\\other.test", "https://example.test"),
  ).toBeUndefined();
});
