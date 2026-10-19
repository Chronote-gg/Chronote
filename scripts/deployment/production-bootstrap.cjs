"use strict";
const {
  WARMUP_SECONDS,
  INITIAL_LEASE_SECONDS,
  LEASE_SECONDS,
  RENEWAL_MARGIN_SECONDS,
} = require("./production-capacity.cjs");
const { isDeepStrictEqual } = require("node:util");
const {
  readRetainedMetadata,
  classifyRetainedWork,
} = require("./retained-work.cjs");
const {
  collectLaunchInventory,
  compareProcessExclusion,
} = require("./production-inventory.cjs");
const { createProductionActions } = require("./production-actions.cjs");
const { createIntroductionHold } = require("./introduction-hold.cjs");
const { candidateSlot } = require("./production-candidate.cjs");
function createProductionBootstrap(options) {
  const {
      binding,
      read,
      write,
      now,
      aws,
      scan,
      inventory,
      candidate,
      evidence,
      compatibilityBinding,
      declaredRoutes,
      sleep,
    } = options,
    m = binding.manifest;
  const table = m.resources.tables.deploymentControl,
    actions = createProductionActions({ ...options, table });
  const control = () => read({ pk: "ENV", sk: "CONTROL" });
  const find = (kind, predicate = () => true) => {
    const found = m.actions.filter((a) => a.kind === kind && predicate(a));
    if (found.length !== 1) throw Error("finite_action_scope_refused");
    return found[0];
  };
  async function wait(check, seconds = 180) {
    const end = Math.min(now() + seconds, m.validUntil);
    for (;;) {
      const value = await check();
      if (value) return value;
      if (now() >= end) throw Error("observation_deadline");
      await sleep(3000);
    }
  }
  async function retained() {
    const snapshot = await readRetainedMetadata({
      tables: m.resources.tables,
      read: scan,
      now: now(),
    });
    const result = classifyRetainedWork(
      snapshot,
      evidence.retainedDisposition,
      compatibilityBinding,
    );
    if (result.reopeningBlockers.length)
      throw Error("retained_work_prerequisite");
    return result;
  }
  const inventoryNow = () =>
    collectLaunchInventory({
      scope: m,
      read: inventory.read,
      now: now(),
      declaredRoutes,
    });
  async function observeServiceStop() {
    return wait(async () => {
      const svc = await candidate.service();
      const taskResponse = await aws("ecs", "describe-tasks", {
        cluster: m.runtime.clusterArn,
        tasks: m.runtime.legacyTaskArns,
      });
      if (
        svc.desiredCount ||
        svc.runningCount ||
        svc.pendingCount ||
        taskResponse.failures?.length ||
        taskResponse.tasks.length !== m.runtime.legacyTaskArns.length ||
        taskResponse.tasks.some(
          (t) => t.lastStatus !== "STOPPED" || t.desiredStatus !== "STOPPED",
        )
      )
        return;
      return {
        serviceArn: svc.serviceArn,
        taskDefinition: svc.taskDefinition,
        desiredCount: 0,
        runningCount: 0,
        pendingCount: 0,
        stoppedTaskArns: taskResponse.tasks.map((t) => t.taskArn),
      };
    });
  }
  async function route(action) {
    return actions.run(action, undefined, async () => {
      const response = await aws("elbv2", "describe-listeners", {
        ListenerArns: [m.resources.listenerArn],
      });
      require("./introduction-transitions.cjs").acknowledgmentFor(
        m,
        action,
        response,
      );
      return {
        listenerArn: m.resources.listenerArn,
        targetGroupArn:
          action.targetGroup === "a"
            ? m.resources.targetGroupA
            : m.resources.targetGroupB,
      };
    });
  }
  async function initialize() {
    if ((await control()) || (await read({ pk: "ENV", sk: "INTRODUCTION" })))
      throw Error("initial_state_prerequisite");
    const before = await inventoryNow();
    if (
      before.blockers.some(
        (b) =>
          ![
            "process_present",
            "service_not_excluded",
            "registered_or_draining_target",
          ].includes(b),
      ) ||
      before.tasks.some(
        (t) =>
          t.lastStatus !== "STOPPED" &&
          !m.runtime.legacyTaskArns.includes(t.taskArn),
      )
    )
      throw Error("launcher_exclusion_prerequisite");
    await createIntroductionHold({ ...options, table }).acquire(binding);
    for (const a of m.actions.filter((a) => a.kind === "stop_legacy")) {
      const task = before.tasks.find((t) => t.taskArn === a.taskArn);
      if (!task || task.group.startsWith("service:"))
        throw Error("standalone_scope_refused");
      await actions.run(a, undefined, () =>
        wait(async () => {
          const response = await aws("ecs", "describe-tasks", {
            cluster: m.runtime.clusterArn,
            tasks: [a.taskArn],
          });
          if (response.failures?.length || response.tasks?.length !== 1)
            throw Error("stop_observation_unavailable");
          return response.tasks[0].lastStatus === "STOPPED"
            ? { taskArn: a.taskArn, lastStatus: "STOPPED" }
            : undefined;
        }),
      );
    }
    const stop = find("stop_service");
    await actions.run(stop, undefined, observeServiceStop);
    await route(find("route_maintenance", (a) => a.targetGroup === "b"));
    const after = await inventoryNow(),
      lineage = [];
    for (const a of m.actions.filter((a) =>
      ["stop_service", "stop_legacy", "route_maintenance"].includes(a.kind),
    ))
      lineage.push(await actions.readAction(a));
    if (
      compareProcessExclusion({
        before,
        after,
        approvedStopArns: m.runtime.legacyTaskArns,
        acknowledgments: lineage,
      }).blockers.length
    )
      throw Error("process_exclusion_prerequisite");
    await retained();
    const initial = {
      pk: "ENV",
      sk: "CONTROL",
      recordType: "control",
      protocolVersion: 1,
      runtimeEnvironment: "ecs",
      coordinatorToken: m.handoff.priorRunToken,
      coordinatorEpoch: 1,
      coordinatorExpiresAt: now() + INITIAL_LEASE_SECONDS,
      servingGeneration: 0,
      servingMembers: {},
      maintenance: {
        holdId: m.holdId,
        introductionId: m.introductionId,
        revision: 1,
      },
    };
    await actions.run(
      find("introduction_write", (a) => a.purpose === "initialize"),
      { control: initial, lineage },
      async () => {
        const value = await control();
        if (!isDeepStrictEqual(value, initial))
          throw Error("initialization_observation_refused");
        return value;
      },
    );
  }
  async function renew(slot) {
    const previous = await control();
    if (previous.coordinatorExpiresAt > now() + RENEWAL_MARGIN_SECONDS) return;
    const at = now();
    await actions.consume(
      "introduction_write",
      (a) => a.purpose === "renew" && a.slot === slot,
      { control: previous, now: at },
      async () => {
        const value = await control();
        if (
          !isDeepStrictEqual(value, {
            ...previous,
            coordinatorExpiresAt: at + LEASE_SECONDS,
          })
        )
          throw Error("lease_observation_refused");
        return value;
      },
    );
  }
  async function launch(slot) {
    const selected = candidateSlot(m, slot);
    await actions.run(
      find("launch_candidate", (a) => a.slot === slot),
      undefined,
      () =>
        wait(async () => {
          try {
            const r = await candidate.inspect(slot);
            return {
              serviceArn: m.runtime.serviceArn,
              taskArn: r.task.taskArn,
              taskDefinition: selected.definition,
              imageDigest: selected.digest,
              lastStatus: "RUNNING",
            };
          } catch (error) {
            if (error.message === "candidate_waiting") return;
            throw error;
          }
        }, WARMUP_SECONDS),
    );
  }
  async function promote(slot) {
    const warm = await wait(async () => {
      await renew(slot);
      try {
        return await candidate.inspect(slot, { ready: true });
      } catch (error) {
        if (error.message === "candidate_waiting") return;
        throw error;
      }
    }, WARMUP_SECONDS);
    await retained();
    const action = find(
      "introduction_write",
      (a) => a.purpose === "promote" && a.slot === slot,
    );
    await actions.run(
      action,
      { runtime: warm.runtime, now: now() },
      async () => {
        const value = await control();
        if (
          value.servingGeneration !== 1 ||
          value.coordinatorExpiresAt !== 0 ||
          !isDeepStrictEqual(value.servingMembers, {
            [warm.runtime.identity.instanceId]: warm.runtime.identity,
          })
        )
          throw Error("promotion_observation_refused");
        return value;
      },
    );
    await route(
      find(
        "route_candidate",
        (a) =>
          a.launchActionId ===
            find("launch_candidate", (a) => a.slot === slot).actionId &&
          a.targetGroup === "a",
      ),
    );
  }
  async function replace() {
    await actions.unsettled();
    const warm = await candidate.inspect("bootstrap");
    await retained();
    const launchRow = await actions.readAction(
      find("launch_candidate", (a) => a.slot === "bootstrap"),
    );
    if (
      launchRow.phase !== "observed" ||
      !launchRow.observation.resourceIds.includes(warm.task.taskArn)
    )
      throw Error("known_launch_prerequisite");
    const lease = await control();
    await wait(
      async () => (await control()).coordinatorExpiresAt <= now(),
      Math.max(0, lease.coordinatorExpiresAt - now()) + 3,
    );
    const previous = await control(),
      at = now();
    await actions.run(
      find("introduction_write", (a) => a.purpose === "replace_control"),
      { control: previous, launch: launchRow, now: at },
      async () => {
        const value = await control();
        if (
          !isDeepStrictEqual(value, {
            ...previous,
            coordinatorToken: m.failedUnserved.runToken,
            coordinatorEpoch: m.failedUnserved.epoch,
            coordinatorExpiresAt: at + LEASE_SECONDS,
          })
        )
          throw Error("replacement_observation_refused");
        return value;
      },
    );
    await actions.run(
      find("introduction_write", (a) => a.purpose === "retire_failed"),
      { control: await control(), runtime: warm.runtime, now: now() },
      () =>
        wait(async () => {
          const row = await read({ pk: "ENV", sk: warm.runtime.sk });
          if (row.role !== "retired" || !row.retirementAcknowledgment) return;
          const request = {
            identity: warm.runtime.identity,
            authorizedGeneration: 0,
            coordinatorToken: m.failedUnserved.runToken,
            coordinatorEpoch: m.failedUnserved.epoch,
          };
          if (
            !isDeepStrictEqual(row.retirementRequest, request) ||
            !isDeepStrictEqual(row.retirementAcknowledgment.request, request) ||
            !row.workCounts ||
            Object.values(row.workCounts).some((n) => n !== 0)
          )
            throw Error("retirement_observation_refused");
          const native = await aws("ecs", "get-task-protection", {
            cluster: m.runtime.clusterArn,
            tasks: [warm.task.taskArn],
          });
          if (
            native.failures?.length ||
            native.protectedTasks?.length !== 1 ||
            native.protectedTasks[0].taskArn !== warm.task.taskArn ||
            native.protectedTasks[0].protectionEnabled !== false
          )
            return;
          return row;
        }),
    );
    await actions.run(find("stop_failed"), undefined, () =>
      wait(async () => {
        const svc = await candidate.service(),
          tasks = await candidate.tasks(),
          stopped = await aws("ecs", "describe-tasks", {
            cluster: m.runtime.clusterArn,
            tasks: [warm.task.taskArn],
          });
        if (
          svc.desiredCount ||
          svc.runningCount ||
          svc.pendingCount ||
          tasks.length ||
          stopped.failures?.length ||
          stopped.tasks?.length !== 1 ||
          stopped.tasks[0].lastStatus !== "STOPPED"
        )
          return;
        return {
          serviceArn: svc.serviceArn,
          taskDefinition: svc.taskDefinition,
          desiredCount: 0,
          runningCount: 0,
          pendingCount: 0,
          taskArn: warm.task.taskArn,
          lastStatus: "STOPPED",
        };
      }),
    );
    const empty = await inventoryNow();
    if (empty.blockers.length)
      throw Error("failed_process_exclusion_prerequisite");
  }
  return {
    initialize,
    launch,
    promote,
    replace,
    find,
    actions,
    wait,
    control,
    retained,
    route,
  };
}
module.exports = { createProductionBootstrap };
