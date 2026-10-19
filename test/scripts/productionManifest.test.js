/** @jest-environment node */
import * as builders from "../../src/services/productionIntroductionTransactions";
import {
  authorityFor,
  assertMutationAllowed,
  createIntroductionHold,
} from "../../scripts/deployment/introduction-hold.cjs";

import { test, expect } from "@jest/globals";
import {
  parsePreparation,
  parseExecution,
  bindExecution,
  canonicalHash,
  publicFailure,
} from "../../scripts/deployment/production-manifest.cjs";
import { fixture, bound } from "../fixtures/productionManifest.js";
test("preparation cannot execute and exact hash, root, foreign and missing bindings refuse", () => {
  expect(
    parsePreparation({
      kind: "preparation",
      schemaVersion: 1,
      environment: "production",
      deferred: ["identity", "runtime"],
    }).kind,
  ).toBe("preparation");
  expect(() => bindExecution({ kind: "preparation" }, {}, {})).toThrow();
  expect(bound().manifestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(() => parseExecution(fixture(), "0".repeat(64))).toThrow();
  for (const change of [
    (m) => delete m.identity.runId,
    (m) => (m.resources.targetGroupB = m.resources.targetGroupA),
    (m) =>
      m.runtime.legacyTaskArns.push(
        "arn:aws:ecs:us-east-1:999999999999:task/app/foreign",
      ),
    (m) => (m.actions[0].command = "stop all"),
    (m) => (m.runtime.cpu = 1024),
  ]) {
    const m = fixture();
    change(m);
    expect(() => parseExecution(m, canonicalHash(m))).toThrow();
  }
  const m = fixture();
  const parsed = parseExecution(m, canonicalHash(m));
  for (const arn of [
    `arn:aws:iam::${m.identity.accountId}:root`,
    `arn:aws:sts::${m.identity.accountId}:assumed-role/deploy/other`,
  ])
    expect(() =>
      bindExecution(
        parsed,
        { ...m.identity, now: 150, endpointOverrides: [] },
        { accountId: m.identity.accountId, arn },
      ),
    ).toThrow();
  expect(() =>
    bindExecution(
      parsed,
      { ...m.identity, now: 201, endpointOverrides: [] },
      {},
    ),
  ).toThrow();
});
test("canonical hash sorts object keys and set arrays but preserves action order", () => {
  const m = fixture();
  m.resources.artifactPrefixes.push("other/");
  const changed = structuredClone(m);
  changed.resources.artifactPrefixes.reverse();
  expect(canonicalHash(changed)).toBe(canonicalHash(m));
  changed.actions.reverse();
  expect(canonicalHash(changed)).not.toBe(canonicalHash(m));
});
test("sensitive validation and provider errors emit only bounded public status", () => {
  const secret = "arn:aws:private:CUSTOMER_SECRET";
  expect(JSON.stringify(publicFailure(new Error(secret)))).not.toContain(
    secret,
  );
  expect(publicFailure(new Error(secret))).toEqual({
    status: "refused",
    reason: "introduction_refused",
  });
});

test("only exact bound introduction action or exact fixture run can cross the held deployment guard", async () => {
  const binding = bound();
  const authority = authorityFor(binding);
  const hold = {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    holdId: "hold",
    introductionId: "intro",
    manifestHash: binding.manifestHash,
    revision: 1,
    admission: { state: "held" },
    deployment: { state: "held" },
  };
  const requestedAction = {
    kind: "introduction_action",
    actionId: "stop",
    operationId: "op",
    actor: binding.actor,
    runToken: "bootstrap-run",
    intentHash: authority.actions.stop.intentHash,
  };
  expect(() =>
    assertMutationAllowed({
      builders,
      hold,
      operationAuthority: authority,
      requestedAction,
      now: 150,
    }),
  ).not.toThrow();
  expect(() =>
    assertMutationAllowed({
      builders,
      hold,
      operationAuthority: authority,
      requestedAction: { ...requestedAction, actionId: "foreign" },
      now: 150,
    }),
  ).toThrow();
  expect(() =>
    assertMutationAllowed({
      builders,
      hold,
      operationAuthority: authority,
      requestedAction,
      now: 201,
    }),
  ).toThrow();
  await expect(
    createIntroductionHold({
      builders,
      table: "t",
      write: () => {
        throw new Error("should not write");
      },
      now: () => 150,
    }).acquire({ ...binding, actor: "arn:aws:iam::123456789012:root" }),
  ).rejects.toThrow();
});
