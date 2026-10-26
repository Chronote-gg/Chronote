import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { stateDigest } from "../../scripts/deployment/production-evidence.cjs";
/** @jest-environment node */
import { expect, test } from "@jest/globals";
import {
  manifestFixture,
  introductionFixture,
} from "../fixtures/deployment/productionIntroduction.js";
import { createProductionIntroduction } from "../../scripts/deployment/introduce-production.cjs";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";
test.each(["fence", "drain", "activate", "abort", "complete", "reconcile"])(
  "CLI dependency absence refuses %s before all writes",
  async (phase) => {
    const manifest = manifestFixture(),
      calls = [];
    const engine = createProductionIntroduction({
      manifest,
      expectedSha256: manifestHash(manifest),
      aws: async (...args) => {
        calls.push(args);
        return {};
      },
      now: () => 1000,
    });
    await expect(engine.run(phase)).rejects.toThrow(
      "Trusted evidence collector unavailable",
    );
    expect(calls).toEqual([]);
  },
);

test("strict engine refuses unknown phase", async () => {
  const manifest = manifestFixture();
  await expect(
    createProductionIntroduction({
      manifest,
      expectedSha256: manifestHash(manifest),
      probe: async () => ({}),
      now: () => 1000,
    }).run("repair"),
  ).rejects.toThrow("Unknown phase");
});
test("strict engine validates envelope before any provider call", async () => {
  const manifest = manifestFixture(),
    calls = [];
  await expect(
    createProductionIntroduction({
      manifest,
      expectedSha256: manifestHash(manifest),
      probe: async () => ({}),
      authorization: {},
      aws: async (...args) => calls.push(args),
      now: () => 1000,
    }).run("fence"),
  ).rejects.toThrow();
  expect(calls).toEqual([]);
});

test("approved later session can drain and pre-shutdown abort restores only owned fence", async () => {
  const f = introductionFixture(marshall, unmarshall, stateDigest);
  await createProductionIntroduction(f.options).run("fence");
  expect(f.isOwned()).toBe(true);
  f.authorize("drain", "124");
  await createProductionIntroduction(f.options).run("drain");
  f.authorize("abort", "125");
  await createProductionIntroduction(f.options).run("abort");
  expect(f.isOwned()).toBe(false);
  expect(f.writes.filter((x) => x[1] === "put-role-policy")).toHaveLength(1);
  expect(f.writes.filter((x) => x[1] === "delete-role-policy")).toHaveLength(1);
});
test("unknown fence acknowledgment leaves submitted receipt and cannot replay", async () => {
  const f = introductionFixture(marshall, unmarshall, stateDigest),
    original = f.options.aws;
  f.options.aws = async (...args) => {
    const result = await original(...args);
    if (args[1] === "put-role-policy") throw new Error("Lost acknowledgment");
    return result;
  };
  await expect(
    createProductionIntroduction(f.options).run("fence"),
  ).rejects.toThrow("Lost acknowledgment");
  expect(f.isOwned()).toBe(true);
  f.authorize("fence", "124");
  await expect(
    createProductionIntroduction(f.options).run("fence"),
  ).rejects.toThrow("Unknown acknowledgment");
  expect(f.writes.filter((x) => x[1] === "put-role-policy")).toHaveLength(1);
});
test("changed session and expired authority refuse before intent", async () => {
  const f = introductionFixture(marshall, unmarshall, stateDigest);
  f.setClock(2000);
  await expect(
    createProductionIntroduction(f.options).run("fence"),
  ).rejects.toThrow("expired");
  expect(f.writes).toEqual([]);
});

test("activation shuts down exactly once and preserves fence on post-shutdown failure", async () => {
  const f = introductionFixture(marshall, unmarshall, stateDigest);
  await createProductionIntroduction(f.options).run("fence");
  f.authorize("drain", "124");
  await createProductionIntroduction(f.options).run("drain");
  f.authorize("activate", "125");
  const original = f.options.aws;
  let shutdowns = 0;
  f.options.aws = async (...args) => {
    if (args[1] === "update-service") {
      shutdowns++;
      f.svc.desiredCount = f.svc.runningCount = 0;
      f.legacy.lastStatus = "STOPPED";
      return {};
    }
    if (args[1] === "describe-listeners")
      throw new Error("Routing unavailable");
    return original(...args);
  };
  await expect(
    createProductionIntroduction(f.options).run("activate"),
  ).rejects.toThrow("Routing unavailable");
  expect(shutdowns).toBe(1);
  expect(f.isOwned()).toBe(true);
});

test("changed head stage cannot reuse an otherwise valid immutable receipt", async () => {
  const f = introductionFixture(marshall, unmarshall, stateDigest);
  await createProductionIntroduction(f.options).run("fence");
  const head = unmarshall(f.rows.get("PRODUCTION_INTRODUCTION"));
  head.stage = "drained";
  f.rows.set("PRODUCTION_INTRODUCTION", marshall(head));
  f.authorize("abort", "124");
  await expect(
    createProductionIntroduction(f.options).run("abort"),
  ).rejects.toThrow("Receipt stage changed");
  expect(f.isOwned()).toBe(true);
});

test.each(["capture", "intent"])(
  "evidence expiring during %s refuses consequential fence write",
  async (delay) => {
    const f = introductionFixture(marshall, unmarshall, stateDigest);
    if (delay === "capture") {
      const original = f.options.probe.readCapture;
      f.options.probe.readCapture = async (reference) => {
        const value = await original(reference);
        f.setClock(1100);
        return value;
      };
    } else {
      const original = f.options.aws;
      f.options.aws = async (...args) => {
        const value = await original(...args);
        if (args[1] === "transact-write-items") f.setClock(1100);
        return value;
      };
    }
    await expect(
      createProductionIntroduction(f.options).run("fence"),
    ).rejects.toThrow();
    expect(
      f.writes.filter((entry) => entry[1] === "put-role-policy"),
    ).toHaveLength(0);
  },
);
