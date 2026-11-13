import { createTRPCClient, TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "../../trpc/router";
import {
  authRecoveryLink,
  setAuthRequestGeneration,
  setAuthRequestsAllowed,
  subscribeAuthTransport,
  createRecoveryUrl,
  readRecoveryAttempt,
  clearRecoveryAttempt,
  type AuthTransportEvent,
} from "./authRecovery";

beforeEach(() => {
  sessionStorage.clear();
  setAuthRequestGeneration(1);
  setAuthRequestsAllowed(true);
});
const unauthorized = () =>
  TRPCClientError.from<AppRouter>({
    error: {
      message: "Authentication required",
      code: -32001,
      data: { code: "UNAUTHORIZED", httpStatus: 401 },
    },
  });

test("the transport reports operation errors separately and never retries a mutation", async () => {
  const events: AuthTransportEvent[] = [];
  const stop = subscribeAuthTransport((event) => events.push(event));
  let requests = 0;
  const terminal: TRPCLink<AppRouter> = () => () =>
    observable((observer) => {
      requests++;
      observer.error(unauthorized());
    });
  const client = createTRPCClient<AppRouter>({
    links: [authRecoveryLink, terminal],
  });
  try {
    await expect(client.servers.listEligible.query()).rejects.toThrow(
      "Authentication required",
    );
    expect(events).toEqual([
      { kind: "unauthorized", generation: 1, path: "servers.listEligible" },
    ]);
    expect(requests).toBe(1);
    setAuthRequestsAllowed(false);
    await expect(
      client.personalUploads.completeUpload.mutate({
        uploadId: "fixture",
        key: "fixture-key",
        uploadToken: "fixture-token",
      }),
    ).rejects.toThrow("Sign-in is paused");
    expect(requests).toBe(1);
  } finally {
    stop();
  }
});

test("a late response cannot publish data or an auth failure into a newer actor", async () => {
  let finish = () => {};
  const terminal: TRPCLink<AppRouter> = () => () =>
    observable((observer) => {
      finish = () => {
        observer.next({ result: { data: { guilds: [] } } });
        observer.complete();
      };
    });
  const client = createTRPCClient<AppRouter>({
    links: [authRecoveryLink, terminal],
  });
  const pending = client.servers.listEligible.query();
  setAuthRequestGeneration(2);
  finish();
  await expect(pending).rejects.toThrow("Session changed");
});

test("public queries remain available while protected requests are paused", async () => {
  setAuthRequestsAllowed(false);
  const terminal: TRPCLink<AppRouter> = () => () =>
    observable((observer) => {
      observer.next({ result: { data: null } });
      observer.complete();
    });
  const client = createTRPCClient<AppRouter>({
    links: [authRecoveryLink, terminal],
  });
  await expect(client.auth.me.query()).resolves.toBeNull();
});

test("an automatic attempt survives a reload and cannot start twice", () => {
  const login =
    "/auth/discord?redirect=" +
    encodeURIComponent(
      "https://example.test/portal/meetings?scope=personal#notes",
    );
  const first = createRecoveryUrl(login);
  expect(
    new URL(first!, window.location.href).searchParams.get("authRecovery"),
  ).toBe(readRecoveryAttempt()?.id);
  expect(createRecoveryUrl(login)).toBeUndefined();
  const explicit = createRecoveryUrl(login, true);
  expect(
    new URL(explicit!, window.location.href).searchParams.get("interaction"),
  ).toBe("consent");
  clearRecoveryAttempt();
  expect(readRecoveryAttempt()).toBeNull();
});

test("unavailable storage never starts an unbounded automatic round trip", () => {
  const write = jest
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw new Error("storage blocked");
    });
  try {
    expect(createRecoveryUrl("/auth/discord")).toBeUndefined();
  } finally {
    write.mockRestore();
  }
});
