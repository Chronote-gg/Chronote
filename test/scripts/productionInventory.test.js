/** @jest-environment node */
import { test, expect } from "@jest/globals";
import {
  collectLaunchInventory,
  compareProcessExclusion,
} from "../../scripts/deployment/production-inventory.cjs";
import { fixture } from "../fixtures/productionManifest.js";
function reader(m, changes = {}) {
  const taskArn = m.runtime.legacyTaskArns[0];
  return async (operation, input) => {
    if (changes[operation]) return changes[operation](input);
    if (operation === "listServices") return { items: [m.runtime.serviceArn] };
    if (operation === "listTasks")
      return { items: input.desiredStatus === "STOPPED" ? [taskArn] : [] };
    if (operation === "describeTasks")
      return {
        items: input.arns.map((taskArn) => ({
          taskArn,
          taskDefinitionArn: m.runtime.legacyDefinition,
          group: "service:app",
          lastStatus: "STOPPED",
          desiredStatus: "STOPPED",
          protectionEnabled: false,
        })),
        failures: [],
      };
    if (operation === "describeServices")
      return {
        items: [
          {
            serviceArn: m.runtime.serviceArn,
            desiredCount: 0,
            runningCount: 0,
            pendingCount: 0,
          },
        ],
        failures: [],
      };
    if (operation === "describeTaskBinding")
      return {
        taskDefinitionArn: m.runtime.legacyDefinition,
        family: "app",
        container: "app",
        mode: "all",
        configurationHash: "d".repeat(64),
        tables: m.resources.tables,
        bucket: m.resources.bucket,
        taskRoleArn: m.resources.taskRoleArn,
        executionRoleArn: m.resources.executionRoleArn,
      };
    if (operation === "targetHealth") return { items: [] };
    if (operation === "readDeclaredRoute")
      return {
        id: input.id,
        evidenceHash: m.launcherRoutes.find((r) => r.id === input.id)
          .evidenceHash,
        state: "held",
      };
    return { items: [] };
  };
}
test("exhausts cluster task pages and directly describes approved legacy tasks omitted from lists", async () => {
  const m = fixture();
  let desired = [];
  let described = [];
  const result = await collectLaunchInventory({
    scope: m,
    now: 150,
    read: reader(m, {
      listTasks: async (input) => {
        desired.push(input.desiredStatus);
        return { items: [] };
      },
      describeTasks: async (input) => {
        described.push(...input.arns);
        return reader(m)("describeTasks", input);
      },
    }),
  });
  expect(desired).toEqual(["RUNNING", "STOPPED"]);
  expect(described).toContain(m.runtime.legacyTaskArns[0]);
  expect(result.blockers).toEqual(["declared_route_unverified"]);
  expect(
    result.coverage
      .filter((c) => c.operation !== "declaredRoute")
      .every((c) => c.status === "enumerated"),
  ).toBe(true);
  expect(
    compareProcessExclusion({
      before: result,
      after: result,
      approvedStopArns: m.runtime.legacyTaskArns,
      acknowledgments: [],
    }).blockers,
  ).toContain("stop_acknowledgment_missing");
});
test.each([
  "pagination",
  "missing",
  "pending",
  "standalone",
  "protection",
  "draining",
  "launcher",
  "unsupported",
])("blocks %s inventory evidence", async (problem) => {
  const m = fixture();
  const task = m.runtime.legacyTaskArns[0];
  const variants = {
    pagination: { listTasks: async () => ({ items: [], nextToken: "cycle" }) },
    missing: { describeTasks: async () => ({ items: [], failures: [] }) },
    pending: {
      describeTasks: async () => ({
        items: [
          {
            taskArn: task,
            taskDefinitionArn: m.runtime.legacyDefinition,
            group: "service:app",
            lastStatus: "PENDING",
            desiredStatus: "RUNNING",
            protectionEnabled: false,
          },
        ],
        failures: [],
      }),
    },
    standalone: {
      describeTasks: async () => ({
        items: [
          {
            taskArn: task,
            taskDefinitionArn: m.runtime.legacyDefinition,
            group: "family:app",
            lastStatus: "RUNNING",
            desiredStatus: "RUNNING",
            protectionEnabled: false,
          },
        ],
        failures: [],
      }),
    },
    protection: {
      describeTasks: async () => ({
        items: [
          {
            taskArn: task,
            taskDefinitionArn: m.runtime.legacyDefinition,
            group: "service:app",
            lastStatus: "STOPPED",
            desiredStatus: "STOPPED",
            protectionEnabled: true,
          },
        ],
        failures: [],
      }),
    },
    draining: {
      targetHealth: async () => ({
        items: [{ targetId: "ip", state: "draining" }],
      }),
    },
    launcher: {
      listScalingPolicies: async () => ({
        items: [
          {
            id: "policy",
            targetArn: m.runtime.serviceArn,
            stateHash: "a".repeat(64),
          },
        ],
      }),
    },
    unsupported: {
      listScheduleGroups: async () => {
        throw new Error("unsupported");
      },
    },
  };
  const result = await collectLaunchInventory({
    scope: m,
    now: 150,
    read: reader(m, variants[problem]),
  });
  expect(
    result.blockers.filter((b) => b !== "declared_route_unverified").length,
  ).toBeGreaterThan(0);
});
test("new matching task after initial inventory is relaunch evidence", async () => {
  const m = fixture(),
    before = await collectLaunchInventory({
      scope: m,
      now: 150,
      read: reader(m),
    });
  const after = structuredClone(before);
  after.tasks.push({
    ...after.tasks[0],
    taskArn: m.runtime.legacyTaskArns[0] + "-new",
  });
  expect(
    compareProcessExclusion({
      before,
      after,
      approvedStopArns: m.runtime.legacyTaskArns,
      acknowledgments: [],
    }).blockers,
  ).toContain("task_relaunch");
});
import { collectAcceptanceInventory } from "../../scripts/deployment/production-inventory.cjs";

test("acceptance discovery directly describes runtime tasks omitted by cluster lists without weakening cold exclusion", async () => {
  const m = fixture();
  const knownTask =
    m.runtime.clusterArn.replace(":cluster/", ":task/") + "/selected";
  const described = [];
  const read = reader(m, {
    describeTasks: async (input) => {
      described.push(...input.arns);
      return reader(m)("describeTasks", input);
    },
  });
  const result = await collectAcceptanceInventory({
    scope: m,
    now: 150,
    read,
    expectedTaskArns: [knownTask],
  });
  expect(described).toContain(knownTask);
  expect(result.tasks).toHaveLength(2);
  expect(result.blockers).toEqual(["declared_route_unverified"]);
});
