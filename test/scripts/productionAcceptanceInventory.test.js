/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  assertAcceptanceWriters,
  readRuntimeInventory,
} from "../../scripts/deployment/production-acceptance-inventory.cjs";
import { writerFixture } from "../fixtures/productionAcceptanceWriters.js";

test("accepts the exact serving and retired writer set at its actual generation", () => {
  expect(assertAcceptanceWriters(writerFixture())).toHaveLength(2);
});
test("native complete runtime inventory refuses an otherwise valid non-UUID identity", async () => {
  const f = writerFixture(),
    row = f.runtimes[0];
  row.identity.instanceId = "legacy-worker";
  row.sk = "RUNTIME#legacy-worker";
  await expect(
    readRuntimeInventory(f.m, {
      aws: async () => ({ Items: [marshall(row)] }),
    }),
  ).rejects.toThrow();
});
test.each([
  "missing runtime",
  "pending owner",
  "pending task",
  "unknown task",
  "unknown target",
  "stale readiness",
  "missing protection",
  "unretired",
  "extra service",
  "incomplete",
  "launcher",
  "generation",
  "overrides",
  "unsafe runtime",
  "unbounded runtime identity",
  "unbounded fixture authority",
])("refuses %s", (problem) => {
  const f = writerFixture();
  const changes = {
    "missing runtime": () => f.runtimes.pop(),
    "pending owner": () => f.runtimes[1].workCounts.pending_admission++,
    "pending task": () => (f.inventory.tasks[2].lastStatus = "PENDING"),
    "unknown task": () =>
      f.inventory.tasks.push({ ...f.inventory.tasks[2], taskArn: "unknown" }),
    "unknown target": () => (f.inventory.targets[0].targetId = "10.0.9.9"),
    "stale readiness": () => (f.runtimes[1].readiness.expiresAt = f.now),
    "missing protection": () =>
      (f.inventory.tasks[2].protectionEnabled = false),
    unretired: () => delete f.runtimes[0].retirementAcknowledgment,
    "extra service": () =>
      f.inventory.services.push({
        ...f.inventory.services[0],
        serviceArn: "unknown",
      }),
    incomplete: () => f.inventory.blockers.push("inventory_incomplete"),
    launcher: () => f.inventory.launchers.push({ id: "external" }),
    generation: () => f.runtimes[1].authorizedGeneration++,
    overrides: () =>
      (f.inventory.tasks[2].overrides = [
        { name: "app", environmentNames: ["BOT_INSTANCE_ID"] },
      ]),
    "unsafe runtime": () =>
      (f.runtimes[0].heartbeatAt = Number.MAX_SAFE_INTEGER + 1),
    "unbounded runtime identity": () =>
      (f.runtimes[0].identity.instanceId = "legacy-worker"),
    "unbounded fixture authority": () =>
      (f.fixtureAuthority.priorEpoch = Number.MAX_SAFE_INTEGER + 1),
  };
  changes[problem]();
  expect(() => assertAcceptanceWriters(f)).toThrow();
});
