/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { fixture, bound } from "../fixtures/productionManifest.js";
import { assertProductionPreflight } from "../../scripts/deployment/production-preflight.cjs";
test("production refuses before stop unless exactly one complete replacement path was reviewed", () => {
  const m = fixture();
  expect(() => assertProductionPreflight(bound(m))).toThrow(
    "failure_path_prerequisite",
  );
});
test("replacement identity cannot alias bootstrap or handoff", () => {
  const m = fixture();
  m.failedUnserved = {
    candidateId: m.runtime.candidateId,
    taskDefinition: m.runtime.candidateDefinition,
    imageDigest: m.runtime.candidateDigest,
    runToken: "repair",
    expectedEpoch: 1,
    epoch: 2,
  };
  expect(() => bound(m)).toThrow();
});

import { completeManifest } from "../fixtures/productionCompleteManifest.js";
test("complete finite normal and repaired routes pass; unused optional capacity has explicit fixture predecessor", () => {
  const m = completeManifest();
  expect(assertProductionPreflight(bound(m)).actions.length).toBe(199);
  const optional = m.actions.find(
    (a) => a.kind === "coordinator_write" && a.purpose === "renew",
  );
  optional.predecessor = "bootstrap-renew";
  expect(() => assertProductionPreflight(bound(m))).toThrow(
    "failure_path_prerequisite",
  );
});
test.each([
  "stop-failed",
  "replacement-launch",
  "retire-failed",
  "replacement-c17",
])("missing %s refuses before first stop", (id) => {
  const m = completeManifest();
  m.actions = m.actions.filter((a) => a.actionId !== id);
  expect(() => assertProductionPreflight(bound(m))).toThrow();
});

import { MINIMUM_ACTIONS } from "../../scripts/deployment/production-capacity.cjs";
test("source-derived 197-action minimum covers both bounded branches; one less refuses", () => {
  const m = completeManifest();
  m.actions = m.actions.filter(
    (a) => !["bootstrap-c1", "replacement-c1"].includes(a.actionId),
  );
  for (const path of ["normal", "replacement"])
    m.actions
      .filter((a) => a.kind === "coordinator_write" && a.path === path)
      .forEach((a, i) => {
        a.sequence = i;
      });
  expect(MINIMUM_ACTIONS).toBe(197);
  expect(assertProductionPreflight(bound(m)).actions).toHaveLength(
    MINIMUM_ACTIONS,
  );
  m.actions = m.actions.filter((a) => a.actionId !== "replacement-renew-7");
  expect(() => assertProductionPreflight(bound(m))).toThrow(
    "failure_path_prerequisite",
  );
});

test("only the action pool has a 200-entry ceiling and a 201st exact action refuses", () => {
  const m = completeManifest();
  m.actions.push({
    actionId: "extra-stop",
    kind: "stop_legacy",
    predecessor: null,
    taskArn: m.runtime.legacyTaskArns[0],
  });
  expect(assertProductionPreflight(bound(m)).actions).toHaveLength(200);
  m.actions.push({
    actionId: "extra-stop-2",
    kind: "stop_legacy",
    predecessor: null,
    taskArn: m.runtime.legacyTaskArns[0],
  });
  expect(() => bound(m)).toThrow();
});
