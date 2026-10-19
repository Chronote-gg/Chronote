/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { fixture } from "../fixtures/productionManifest.js";
import {
  parseExecution,
  canonicalHash,
} from "../../scripts/deployment/production-manifest.cjs";
import {
  requestFor,
  acknowledgmentFor,
  observationFor,
} from "../../scripts/deployment/introduction-transitions.cjs";
import { compareProcessExclusion } from "../../scripts/deployment/production-inventory.cjs";
const action = {
  actionId: "stop-service",
  kind: "stop_service",
  predecessor: null,
};
test("service stop pins the legacy definition and records direct desired-zero ACK separately from stopped observation", () => {
  const m = fixture();
  m.actions[0] = { ...action, actionId: "stop" };
  expect(parseExecution(m, canonicalHash(m))).toEqual(m);
  expect(requestFor(m, action)).toEqual({
    operation: "updateService",
    input: {
      cluster: m.runtime.clusterArn,
      service: m.runtime.serviceArn,
      taskDefinition: m.runtime.legacyDefinition,
      desiredCount: 0,
    },
  });
  const service = {
    serviceArn: m.runtime.serviceArn,
    taskDefinition: m.runtime.legacyDefinition,
    desiredCount: 0,
  };
  expect(acknowledgmentFor(m, action, { service }).resourceIds).toEqual([
    m.runtime.serviceArn,
    m.runtime.legacyDefinition,
  ]);
  expect(() =>
    acknowledgmentFor(m, action, { service: { ...service, desiredCount: 1 } }),
  ).toThrow();
  const observed = {
    ...service,
    runningCount: 0,
    pendingCount: 0,
    stoppedTaskArns: m.runtime.legacyTaskArns,
  };
  expect(observationFor(m, action, observed).evidenceHash).toBe(
    canonicalHash(observed),
  );
  expect(() =>
    observationFor(m, action, { ...observed, pendingCount: 1 }),
  ).toThrow();
});
test("process exclusion requires service ACK for scheduler-owned tasks, never individual stop ACK fiction", () => {
  const m = fixture();
  const taskArn = m.runtime.legacyTaskArns[0];
  const task = {
    taskArn,
    taskDefinitionArn: m.runtime.legacyDefinition,
    group: "service:app",
    lastStatus: "RUNNING",
    desiredStatus: "RUNNING",
  };
  const service = {
    serviceArn: m.runtime.serviceArn,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
  };
  const before = {
    scopeHash: canonicalHash(m),
    observedAt: 150,
    approvedStopArns: [taskArn],
    blockers: ["process_present", "service_not_excluded"],
    tasks: [task],
    services: [service],
  };
  const after = {
    ...before,
    observedAt: 151,
    blockers: [],
    tasks: [{ ...task, lastStatus: "STOPPED", desiredStatus: "STOPPED" }],
    services: [{ ...service, desiredCount: 0, runningCount: 0 }],
  };
  const receipt = {
    kind: "stop_service",
    manifestHash: before.scopeHash,
    phase: "observed",
    acknowledgment: {
      resourceIds: [service.serviceArn, m.runtime.legacyDefinition],
    },
  };
  const compare = (acknowledgments) =>
    compareProcessExclusion({
      before,
      after,
      approvedStopArns: [taskArn],
      acknowledgments,
    }).blockers;
  expect(compare([receipt])).toEqual([]);
  expect(compare([{ ...receipt, phase: "submitted" }])).toContain(
    "stop_acknowledgment_missing",
  );
  expect(
    compare([
      {
        ...receipt,
        kind: "stop_legacy",
        acknowledgment: { resourceIds: [taskArn] },
      },
    ]),
  ).toContain("stop_acknowledgment_missing");
});
