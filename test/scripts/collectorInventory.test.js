/** @jest-environment node */
import { test, expect, jest } from "@jest/globals";
import {
  collectPages,
  collectNativeInventory,
} from "../../scripts/deployment/collector-inventory.cjs";
import { nativeTransport } from "../../scripts/deployment/collector-native.cjs";
import { manifestFixture } from "../fixtures/deployment/productionIntroduction.js";
test("native inventories retain every page and reject repeated continuation tokens", async () => {
  const m = manifestFixture();
  let calls = 0;
  const result = await collectPages(
    async () => {
      calls++;
      return {
        taskArns: [String(calls)],
        ...(calls === 1 ? { nextToken: "next" } : {}),
      };
    },
    m,
    "ecs",
    "list-tasks",
    {},
    "taskArns",
    "nextToken",
    "nextToken",
  );
  expect(result.rows).toEqual(["1", "2"]);
  expect(result.pages).toHaveLength(2);
  await expect(
    collectPages(
      async () => ({ taskArns: [], nextToken: "same" }),
      m,
      "ecs",
      "list-tasks",
      {},
      "taskArns",
      "nextToken",
      "nextToken",
    ),
  ).rejects.toThrow(/cursor/);
});
test("native operation denial is a concrete collection prerequisite, not evidence of absence", async () => {
  const m = manifestFixture();
  await expect(
    collectNativeInventory({
      m,
      request: { taskArn: m.legacyTaskArn },
      aws: async () => {
        throw new Error("secret");
      },
    }),
  ).rejects.toThrow(/UNKNOWN: native ecs.list-tasks/);
});

test("native reads cancel at the thirty second cap and never retry", async () => {
  jest.useFakeTimers();
  const aws = jest.fn(
    (service, operation, input, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("synthetic cancellation")),
          { once: true },
        );
      }),
  );
  try {
    const native = nativeTransport(aws, Date.now() / 1000 + 120);
    const result = expect(native("ecs", "list-tasks", {})).rejects.toThrow(
      "UNKNOWN: native ecs.list-tasks",
    );
    await jest.advanceTimersByTimeAsync(30000);
    await result;
    expect(aws).toHaveBeenCalledTimes(1);
    expect(aws.mock.calls[0][3].signal.aborted).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
test("expired native interval prevents the next inventory page from starting", async () => {
  let now = 1000;
  const aws = jest.fn(async () => {
    now = 2000;
    return { taskArns: [], nextToken: "later" };
  });
  const native = nativeTransport(aws, 2, () => now);
  await expect(
    collectPages(
      native,
      manifestFixture(),
      "ecs",
      "list-tasks",
      {},
      "taskArns",
      "nextToken",
      "nextToken",
    ),
  ).rejects.toThrow(/UNKNOWN/);
  expect(aws).toHaveBeenCalledTimes(1);
});
