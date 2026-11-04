/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
import {
  assertBreakGlassDispatch,
  runGate,
} from "../../scripts/deployment/break-glass-guard.cjs";
import { dispatchEnv } from "../deployment/fixtures/breakGlassFixture";

test("admits BASIC's break-glass dispatch with a reason and manifest hash", () => {
  expect(
    assertBreakGlassDispatch({
      ...dispatchEnv,
      BREAK_GLASS_REASON: "  voice leave fix ",
    }),
  ).toEqual({
    actor: "BASIC-BIT",
    triggeringActor: "BASIC-BIT",
    runId: "41521247472",
    runAttempt: "1",
    commitSha: "c".repeat(40),
    reason: "voice leave fix",
    manifestSha256: "d".repeat(64),
  });
});

test.each([
  ["a push", { GITHUB_EVENT_NAME: "push" }, /workflow_dispatch/],
  ["another ref", { GITHUB_REF: "refs/heads/hotfix" }, /only master/],
  ["another actor", { GITHUB_ACTOR: "someone" }, /Only BASIC-BIT/],
  [
    "a re-run by someone else",
    { GITHUB_TRIGGERING_ACTOR: "someone" },
    /Only BASIC-BIT/,
  ],
  ["no run id", { GITHUB_RUN_ID: "" }, /run id/],
  ["no run attempt", { GITHUB_RUN_ATTEMPT: "0" }, /run attempt/],
  ["an empty reason", { BREAK_GLASS_REASON: "   " }, /break_glass_reason/],
  [
    "an overlong reason",
    { BREAK_GLASS_REASON: "x".repeat(1025) },
    /break_glass_reason/,
  ],
  [
    "an uppercase hash",
    { BREAK_GLASS_MANIFEST_SHA256: "D".repeat(64) },
    /64 lowercase hex/,
  ],
  [
    "a short hash",
    { BREAK_GLASS_MANIFEST_SHA256: "d".repeat(63) },
    /64 lowercase hex/,
  ],
  [
    "a padded hash",
    { BREAK_GLASS_MANIFEST_SHA256: ` ${"d".repeat(64)}` },
    /64 lowercase hex/,
  ],
])("refuses %s", (_case, change, message) => {
  expect(() => assertBreakGlassDispatch({ ...dispatchEnv, ...change })).toThrow(
    message,
  );
});

function output() {
  return { log: jest.fn(), error: jest.fn() };
}

test("the gate refuses before querying GitHub when the dispatch is not admitted", async () => {
  const request = jest.fn<typeof fetch>();
  const out = output();
  await expect(
    runGate({ ...dispatchEnv, GITHUB_ACTOR: "someone" }, out, request),
  ).resolves.toBe(1);
  expect(request).not.toHaveBeenCalled();
  expect(out.error).toHaveBeenCalledWith(
    expect.stringContaining("::error title=Break-glass refused::Only"),
  );
});

test("the gate refuses when GitHub does not answer", async () => {
  const request = jest.fn<typeof fetch>(
    async () => new Response("", { status: 502 }),
  );
  const out = output();
  await expect(
    runGate(
      { ...dispatchEnv, GITHUB_REPOSITORY: "owner/repo", GITHUB_TOKEN: "t" },
      out,
      request,
    ),
  ).resolves.toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(out.log).not.toHaveBeenCalled();
});
