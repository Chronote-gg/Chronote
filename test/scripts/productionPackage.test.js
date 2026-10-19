/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { fixture } from "../fixtures/productionManifest.js";
import {
  materializePackage,
  packageIntentHash,
} from "../../scripts/deployment/production-package.cjs";
function packageFixture() {
  const manifest = fixture();
  for (const key of ["runId", "runAttempt", "sessionName"])
    manifest.identity[key] = "$CURRENT";
  return {
    schemaVersion: 1,
    manifest,
    identitySlots: ["runId", "runAttempt", "sessionName"],
    repositoryId: "1234",
    repositoryOwnerId: "4321",
  };
}
test("materializes only closed current identity slots, preserving approved whole-package intent", () => {
  const p = packageFixture();
  const m = fixture();
  const hash = packageIntentHash(p);
  const context = {
    ...m.identity,
    now: 150,
    endpointOverrides: [],
    repositoryId: "1234",
    repositoryOwnerId: "4321",
  };
  const caller = {
    accountId: m.identity.accountId,
    arn: `arn:aws:sts::${m.identity.accountId}:assumed-role/deploy/${m.identity.sessionName}`,
  };
  const result = materializePackage(p, hash, context, caller);
  expect(result.binding.manifest).toEqual(m);
  expect(result.packageIntentHash).toBe(hash);
  expect(result.binding.manifestHash).not.toBe(hash);
  p.manifest.resources.bucket = "other";
  expect(() => materializePackage(p, hash, context, caller)).toThrow();
});
test("rejects nonidentity slots and foreign current source/repository identity", () => {
  const p = packageFixture();
  const context = {
    ...fixture().identity,
    now: 150,
    endpointOverrides: [],
    repositoryId: "1234",
    repositoryOwnerId: "4321",
  };
  p.identitySlots.push("sourceCommit");
  expect(() => packageIntentHash(p)).toThrow();
  p.identitySlots.pop();
  expect(() =>
    materializePackage(
      p,
      packageIntentHash(p),
      { ...context, repositoryId: "foreign" },
      {},
    ),
  ).toThrow();
});
