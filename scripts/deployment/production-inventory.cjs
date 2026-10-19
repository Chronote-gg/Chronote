"use strict";
const { z } = require("zod");
const { isDeepStrictEqual } = require("node:util");
const { canonicalHash, parseExecution } = require("./production-manifest.cjs");
const id = z.string().min(1);
const taskSchema = z
  .object({
    taskArn: id,
    taskDefinitionArn: id,
    group: id,
    lastStatus: id,
    desiredStatus: id,
    protectionEnabled: z.boolean(),
  })
  .strict();
const serviceSchema = z
  .object({
    serviceArn: id,
    desiredCount: z.number().int().nonnegative(),
    runningCount: z.number().int().nonnegative(),
    pendingCount: z.number().int().nonnegative(),
  })
  .strict();
const launcherMetadata = z
  .object({
    id,
    targetArn: id.optional(),
    stateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    state: id.optional(),
  })
  .strict();
const targetMetadata = z
  .object({ targetId: id, state: id, taskArn: id.optional() })
  .strict();
function pageItems(operation, items) {
  if (["listServices", "listTasks"].includes(operation))
    return z.array(id).parse(items);
  if (operation === "targetHealth") return z.array(targetMetadata).parse(items);
  return z.array(launcherMetadata).parse(items);
}
function classifyTask({ m, task, binding, block }) {
  const expected = {
    taskDefinitionArn: task.taskDefinitionArn,
    family: m.runtime.family,
    container: m.runtime.container,
    mode: m.runtime.mode,
    configurationHash: m.runtime.configurationHash,
    tables: m.resources.tables,
    bucket: m.resources.bucket,
    taskRoleArn: m.resources.taskRoleArn,
    executionRoleArn: m.resources.executionRoleArn,
  };
  task.classification =
    isDeepStrictEqual(binding, expected) &&
    [
      m.runtime.legacyDefinition,
      m.runtime.candidateDefinition,
      m.runtime.continuationDefinition,
    ].includes(task.taskDefinitionArn)
      ? "related"
      : "unknown";
  if (task.classification === "unknown") block("unknown_task_binding");
  if (
    !task.taskArn.startsWith(
      m.runtime.clusterArn.replace(":cluster/", ":task/") + "/",
    )
  )
    block("foreign_task");
  if (task.lastStatus !== "STOPPED" || task.desiredStatus !== "STOPPED")
    block("process_present");
  if (task.group !== `service:${m.runtime.serviceArn.split("/").at(-1)}`)
    block("standalone_task");
  if (task.protectionEnabled) block("unexpected_protection");
}
async function inspectTaskBindings({ m, read, base, result, block }) {
  const definitions = new Map();
  for (const task of result.tasks) {
    let binding = definitions.get(task.taskDefinitionArn);
    if (!binding) {
      try {
        binding = await read("describeTaskBinding", {
          ...base,
          taskDefinitionArn: task.taskDefinitionArn,
        });
        definitions.set(task.taskDefinitionArn, binding);
      } catch {
        block("task_binding_unreadable");
      }
    }
    classifyTask({ m, task, binding, block });
  }
}
async function collectLaunchInventory({ scope, read, now }) {
  const m = parseExecution(scope, canonicalHash(scope));
  const result = {
    scopeHash: canonicalHash(m),
    approvedStopArns: m.runtime.legacyTaskArns,
    observedAt: now,
    coverage: [],
    tasks: [],
    services: [],
    launchers: [],
    targets: [],
    blockers: [],
  };
  const base = {
    accountId: m.identity.accountId,
    region: m.identity.region,
    clusterArn: m.runtime.clusterArn,
  };
  const block = (reason) => result.blockers.push(reason);
  async function pages(operation, input = {}) {
    const items = [],
      tokens = new Set();
    let nextToken;
    try {
      do {
        const page = await read(operation, {
          ...base,
          ...input,
          ...(nextToken ? { nextToken } : {}),
        });
        if (
          !page ||
          !Array.isArray(page.items) ||
          Object.keys(page).some((k) => !["items", "nextToken"].includes(k))
        )
          throw new Error();
        const parsed = pageItems(operation, page.items);
        if (
          parsed.some((item) =>
            items.some((prior) => isDeepStrictEqual(prior, item)),
          )
        )
          throw new Error();
        items.push(...parsed);
        nextToken = page.nextToken;
        if (nextToken !== undefined) {
          id.parse(nextToken);
          if (tokens.has(nextToken) || tokens.size >= 1000) throw new Error();
          tokens.add(nextToken);
        }
      } while (nextToken !== undefined);
      result.coverage.push({ operation, scope: input, status: "enumerated" });
    } catch {
      result.coverage.push({ operation, scope: input, status: "incomplete" });
      block("inventory_incomplete");
    }
    return items;
  }
  async function batch(operation, arns, key, schema) {
    const items = [];
    try {
      for (let i = 0; i < arns.length; i += 100) {
        const selected = arns.slice(i, i + 100),
          response = await read(operation, { ...base, arns: selected });
        if (
          !Array.isArray(response?.items) ||
          !Array.isArray(response.failures) ||
          response.failures.length
        )
          throw new Error();
        const parsed = response.items.map((item) => schema.parse(item));
        if (
          parsed.length !== selected.length ||
          new Set(parsed.map((v) => v[key])).size !== parsed.length ||
          !parsed.every((v) => selected.includes(v[key]))
        )
          throw new Error();
        items.push(...parsed);
      }
      result.coverage.push({ operation, status: "enumerated" });
    } catch {
      result.coverage.push({ operation, status: "incomplete" });
      block("description_incomplete");
    }
    return items;
  }
  const services = await pages("listServices");
  if (
    new Set(services).size !== services.length ||
    !services.includes(m.runtime.serviceArn)
  )
    block("service_inventory_mismatch");
  result.services = await batch(
    "describeServices",
    [...new Set([...services, m.runtime.serviceArn])],
    "serviceArn",
    serviceSchema,
  );
  if (
    result.services.some(
      (s) =>
        s.serviceArn !== m.runtime.serviceArn ||
        s.desiredCount !== 0 ||
        s.runningCount !== 0 ||
        s.pendingCount !== 0,
    )
  )
    block("service_not_excluded");
  const running = await pages("listTasks", { desiredStatus: "RUNNING" }),
    stopped = await pages("listTasks", { desiredStatus: "STOPPED" });
  if (
    new Set(running).size !== running.length ||
    new Set(stopped).size !== stopped.length
  )
    block("duplicate_task_identity");
  const arns = [
    ...new Set([...running, ...stopped, ...m.runtime.legacyTaskArns]),
  ];
  result.tasks = await batch("describeTasks", arns, "taskArn", taskSchema);
  await inspectTaskBindings({ m, read, base, result, block });
  for (const targetGroupArn of [
    m.resources.targetGroupA,
    m.resources.targetGroupB,
  ]) {
    const targets = await pages("targetHealth", { targetGroupArn });
    result.targets.push(
      ...targets.map((target) => ({ targetGroupArn, ...target })),
    );
    if (targets.length) block("registered_or_draining_target");
  }
  for (const operation of [
    "listScalingTargets",
    "listScalingPolicies",
    "listScalingScheduledActions",
  ])
    result.launchers.push(
      ...(await pages(operation)).map((item) => ({ operation, ...item })),
    );
  const buses = await pages("listEventBuses");
  for (const eventBusId of new Set([
    "default",
    ...buses.map((bus) => bus.id),
  ])) {
    const rules = await pages("listRules", { eventBusId });
    for (const rule of rules) {
      const targets = await pages("listRuleTargets", {
        eventBusId,
        ruleId: rule.id,
      });
      result.launchers.push({
        operation: "eventbridge",
        eventBusId,
        ...rule,
        targets,
      });
    }
  }
  const groups = await pages("listScheduleGroups");
  for (const group of [
    { id: "default" },
    ...groups.filter((group) => group.id !== "default"),
  ]) {
    if (!id.safeParse(group.id).success) {
      block("launcher_metadata_invalid");
      continue;
    }
    result.launchers.push(
      ...(await pages("listSchedules", { groupId: group.id })).map((item) => ({
        operation: "scheduler",
        ...item,
      })),
    );
  }
  // Launcher payloads are deliberately unavailable. A present launcher needs a typed hold/restore adapter.
  if (result.launchers.length) block("launcher_recipe_unsupported");
  for (const route of m.launcherRoutes) {
    result.coverage.push({
      operation: "declaredRoute",
      scope: { kind: route.kind, id: route.id },
      status: "unsupported",
    });
    block("declared_route_unverified");
  }
  result.blockers = [...new Set(result.blockers)];
  return result;
}
function compareProcessExclusion({
  before,
  after,
  approvedStopArns,
  acknowledgments,
}) {
  const blockers = [
    ...before.blockers.filter(
      (reason) =>
        ![
          "process_present",
          "service_not_excluded",
          "registered_or_draining_target",
        ].includes(reason),
    ),
    ...after.blockers,
  ];
  if (
    before.scopeHash !== after.scopeHash ||
    after.observedAt < before.observedAt
  )
    blockers.push("inventory_scope_mismatch");
  if (
    !isDeepStrictEqual(
      [...approvedStopArns].sort(),
      [...after.approvedStopArns].sort(),
    ) ||
    !isDeepStrictEqual(before.approvedStopArns, after.approvedStopArns)
  )
    blockers.push("stop_scope_mismatch");
  const prior = new Set(before.tasks.map((t) => t.taskArn));
  if (after.tasks.some((t) => !prior.has(t.taskArn)))
    blockers.push("task_relaunch");
  for (const arn of approvedStopArns) {
    if (
      !acknowledgments.some(
        (a) =>
          a.kind === "stop_legacy" &&
          a.manifestHash === after.scopeHash &&
          ["acknowledged", "observed"].includes(a.phase) &&
          a.acknowledgment?.resourceIds.length === 1 &&
          a.acknowledgment.resourceIds[0] === arn,
      )
    )
      blockers.push("stop_acknowledgment_missing");
    if (
      !after.tasks.some(
        (t) =>
          t.taskArn === arn &&
          t.lastStatus === "STOPPED" &&
          t.desiredStatus === "STOPPED",
      )
    )
      blockers.push("stop_observation_missing");
  }
  return {
    blockers: [...new Set(blockers)],
    evidenceHash: canonicalHash({
      before,
      after,
      approvedStopArns,
      acknowledgments,
    }),
    observedAt: after.observedAt,
  };
}
module.exports = { collectLaunchInventory, compareProcessExclusion };
