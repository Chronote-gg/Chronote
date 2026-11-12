/** @jest-environment node */
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { test, expect } from "@jest/globals";
import { boundedBody } from "../../scripts/deployment/collector-principal.cjs";

const BODY_LIMIT_BYTES = 4;
const DEADLINE_MILLIS = 20;
const UNHURRIED_DEADLINE_MILLIS = 1000;

test("a body within the limit is decoded as text", async () => {
  await expect(
    boundedBody(
      Readable.from([Buffer.from("ab"), Buffer.from("cd")]),
      BODY_LIMIT_BYTES,
      AbortSignal.timeout(UNHURRIED_DEADLINE_MILLIS),
    ),
  ).resolves.toBe("abcd");
});

test("a body over the limit is refused", async () => {
  await expect(
    boundedBody(
      Readable.from([Buffer.from("abcde")]),
      BODY_LIMIT_BYTES,
      AbortSignal.timeout(UNHURRIED_DEADLINE_MILLIS),
    ),
  ).rejects.toThrow("UNKNOWN: response size");
});

test("a body that never ends is bounded by the deadline", async () => {
  const blocked = new Readable({ read() {} });
  await expect(
    boundedBody(
      blocked,
      BODY_LIMIT_BYTES,
      AbortSignal.timeout(DEADLINE_MILLIS),
    ),
  ).rejects.toThrow("UNKNOWN: invocation deadline");
  blocked.destroy();
});
