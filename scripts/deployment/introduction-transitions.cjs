"use strict";
const { randomUUID } = require("node:crypto");
const { z } = require("zod");
const {
  canonicalHash,
  assertBoundExecution,
} = require("./production-manifest.cjs");
const { modules } = require("./introduction-hold.cjs");
function refuse() {
  throw new Error("introduction_refused");
}
function requestFor(m, a) {
  const r = m.runtime,
    s = m.resources;
  switch (a.kind) {
    case "stop_failed":
      return {
        operation: "updateService",
        input: {
          cluster: r.clusterArn,
          service: r.serviceArn,
          taskDefinition: r.candidateDefinition,
          desiredCount: 0,
        },
      };
    case "stop_service":
      return {
        operation: "updateService",
        input: {
          cluster: r.clusterArn,
          service: r.serviceArn,
          taskDefinition: r.legacyDefinition,
          desiredCount: 0,
        },
      };
    case "stop_legacy":
      return {
        operation: "stopTask",
        input: {
          cluster: r.clusterArn,
          task: a.taskArn,
          reason: "approved production introduction",
        },
      };
    case "route_candidate":
      return {
        operation: "modifyListener",
        input: {
          ListenerArn: s.listenerArn,
          DefaultActions: require("./routing.cjs").action(
            { sourceGroup: s.targetGroupA, candidateGroup: s.targetGroupB },
            a.targetGroup === "b",
          ),
        },
      };
    case "route_maintenance":
      return {
        operation: "modifyListener",
        input: {
          ListenerArn: s.listenerArn,
          DefaultActions: [
            {
              Type: "forward",
              TargetGroupArn:
                a.targetGroup === "a" ? s.targetGroupA : s.targetGroupB,
            },
          ],
        },
      };
    case "launch_candidate":
      return {
        operation: "updateService",
        input: {
          cluster: r.clusterArn,
          service: r.serviceArn,
          taskDefinition:
            a.slot === "bootstrap"
              ? r.candidateDefinition
              : a.slot === "replacement"
                ? m.failedUnserved.taskDefinition
                : r.continuationDefinition,
          desiredCount: 1,
        },
      };
    default:
      return refuse(); // Unsupported launcher recipes remain blockers until their exact adapters exist.
  }
}
function acknowledgedListener(m, a, response) {
  const expected = requestFor(m, a).input;
  const target = z.literal(
    a.targetGroup === "a" ? m.resources.targetGroupA : m.resources.targetGroupB,
  );
  if (
    a.kind === "route_candidate" &&
    response?.Listeners?.length === 1 &&
    response.Listeners[0].ListenerArn === expected.ListenerArn &&
    require("node:util").isDeepStrictEqual(
      require("./routing.cjs").canonical(response.Listeners[0].DefaultActions),
      require("./routing.cjs").canonical(expected.DefaultActions),
    )
  )
    return expected;
  // Match routing.cjs semantics while accepting the provider's single-target form.
  const forward = z
    .object({
      Type: z.literal("forward"),
      Order: z.literal(1).optional(),
      TargetGroupArn: target.optional(),
      ForwardConfig: z
        .object({
          TargetGroups: z
            .array(
              z
                .object({
                  TargetGroupArn: target,
                  Weight: z.number().int().min(1).max(999).optional(),
                })
                .strict(),
            )
            .length(1),
          TargetGroupStickinessConfig: z
            .object({
              Enabled: z.literal(false),
              DurationSeconds: z.number().int().min(1).max(604800).optional(),
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict()
    .refine((value) => value.TargetGroupArn || value.ForwardConfig);
  const listeners = response?.Listeners;
  if (
    !Array.isArray(listeners) ||
    listeners.length !== 1 ||
    listeners[0].ListenerArn !== expected.ListenerArn ||
    !z.array(forward).length(1).safeParse(listeners[0].DefaultActions).success
  )
    refuse();
  return expected;
}
function acknowledgedService(m, a, response) {
  const expected = requestFor(m, a).input;
  if (
    response?.service?.serviceArn !== expected.service ||
    response.service.taskDefinition !== expected.taskDefinition ||
    response.service.desiredCount !== expected.desiredCount
  )
    refuse();
  return [expected.service, expected.taskDefinition];
}
function acknowledgmentFor(m, a, response) {
  let resourceIds;
  switch (a.kind) {
    case "stop_legacy":
      if (
        response?.task?.taskArn !== a.taskArn ||
        response.task.desiredStatus !== "STOPPED"
      )
        refuse();
      resourceIds = [a.taskArn];
      break;
    case "route_maintenance":
    case "route_candidate": {
      const expected = acknowledgedListener(m, a, response);
      resourceIds = [
        expected.ListenerArn,
        a.targetGroup === "a"
          ? m.resources.targetGroupA
          : m.resources.targetGroupB,
      ];
      break;
    }
    case "stop_service":
    case "stop_failed":
    case "launch_candidate": {
      resourceIds = acknowledgedService(m, a, response);
      break;
    }
    default:
      return refuse();
  }
  return {
    resourceIds,
    evidenceHash: canonicalHash({
      kind: a.kind,
      resourceIds,
      request: requestFor(m, a),
    }),
  };
}
function observationFor(m, a, input) {
  const id = z.string().min(1);
  let observation;
  switch (a.kind) {
    case "stop_failed":
      observation = z
        .object({
          serviceArn: z.literal(m.runtime.serviceArn),
          taskDefinition: z.literal(m.runtime.candidateDefinition),
          desiredCount: z.literal(0),
          runningCount: z.literal(0),
          pendingCount: z.literal(0),
          taskArn: id,
          lastStatus: z.literal("STOPPED"),
        })
        .strict()
        .parse(input);
      break;
    case "stop_service":
      observation = z
        .object({
          serviceArn: z.literal(m.runtime.serviceArn),
          taskDefinition: z.literal(m.runtime.legacyDefinition),
          desiredCount: z.literal(0),
          runningCount: z.literal(0),
          pendingCount: z.literal(0),
          stoppedTaskArns: z
            .array(id)
            .refine(
              (v) =>
                canonicalHash([...v].sort()) ===
                canonicalHash([...m.runtime.legacyTaskArns].sort()),
            ),
        })
        .strict()
        .parse(input);
      break;
    case "stop_legacy":
      observation = z
        .object({
          taskArn: z.literal(a.taskArn),
          lastStatus: z.literal("STOPPED"),
        })
        .strict()
        .parse(input);
      break;
    case "route_maintenance":
    case "route_candidate":
      observation = z
        .object({
          listenerArn: z.literal(m.resources.listenerArn),
          targetGroupArn: z.literal(
            a.targetGroup === "a"
              ? m.resources.targetGroupA
              : m.resources.targetGroupB,
          ),
        })
        .strict()
        .parse(input);
      break;
    case "launch_candidate": {
      const r = m.runtime;
      observation = z
        .object({
          serviceArn: z.literal(r.serviceArn),
          taskArn: id,
          taskDefinition: z.literal(
            a.slot === "bootstrap"
              ? r.candidateDefinition
              : a.slot === "replacement"
                ? m.failedUnserved.taskDefinition
                : r.continuationDefinition,
          ),
          imageDigest: z.literal(
            a.slot === "bootstrap"
              ? r.candidateDigest
              : a.slot === "replacement"
                ? m.failedUnserved.imageDigest
                : r.continuationDigest,
          ),
          lastStatus: z.literal("RUNNING"),
        })
        .strict()
        .parse(input);
      if (
        !observation.taskArn.startsWith(
          r.clusterArn.replace(":cluster/", ":task/") + "/",
        ) ||
        r.legacyTaskArns.includes(observation.taskArn)
      )
        refuse();
      break;
    }
    default:
      return refuse();
  }
  return {
    resourceIds: Object.values(observation)
      .flat()
      .filter((v) => typeof v === "string" && v.startsWith("arn:")),
    evidenceHash: canonicalHash(observation),
  };
}
function createJournal(options, recipes) {
  const builders = modules(options),
    { binding, hold, authority, table, read, write, now, invoke } = options;
  const m = binding.manifest,
    tables = { deploymentControl: table },
    responses = new Map();
  if (table !== m.resources.tables.deploymentControl) refuse();
  const actionFor = (id) => {
    const a = m.actions.find((a) => a.actionId === id);
    if (!a) refuse();
    return a;
  };
  async function readAction(id) {
    const action = builders.introductionActionSchema.parse(
      await read({
        pk: `INTRODUCTION#${m.introductionId}`,
        sk: `ACTION#${id}`,
      }),
    );
    if (
      action.manifestHash !== binding.manifestHash ||
      action.operationId !== authority.operationId ||
      action.actor !== binding.actor ||
      action.intentHash !== authority.actions[id]?.intentHash ||
      action.actionId !== id ||
      action.holdId !== hold.holdId ||
      action.introductionId !== hold.introductionId ||
      action.revision !== hold.revision ||
      action.runToken !== authority.runToken ||
      action.kind !== actionFor(id).kind
    )
      refuse();
    return action;
  }
  const transition = (previous, next) =>
    write(
      builders.buildTransitionIntroductionAction({
        hold,
        authority,
        previous,
        next,
        now: now(),
        tables,
      }),
    );
  async function acknowledge(id) {
    const retained = responses.get(id);
    if (!retained) refuse();
    await transition(retained.previous, retained.next);
    responses.delete(id);
    return retained.next;
  }
  return {
    readAction,
    acknowledge,
    async reserveAction(id, context) {
      assertBoundExecution(binding, now());
      const a = actionFor(id),
        request = recipes.request(m, a, context);
      let predecessor = null;
      if (a.predecessor) {
        const previous = await readAction(a.predecessor);
        if (previous.phase !== "observed") refuse();
        predecessor = {
          actionId: previous.actionId,
          receiptHash: previous.observation.evidenceHash,
        };
      }
      if (a.kind === "route_candidate") {
        const launch = await readAction(a.launchActionId);
        if (launch.phase !== "observed" || launch.kind !== "launch_candidate")
          refuse();
      }
      const action = {
        pk: `INTRODUCTION#${m.introductionId}`,
        sk: `ACTION#${id}`,
        recordType: "introduction_action",
        holdId: hold.holdId,
        introductionId: hold.introductionId,
        manifestHash: binding.manifestHash,
        operationId: authority.operationId,
        revision: hold.revision,
        actor: binding.actor,
        runToken: authority.runToken,
        actionId: id,
        kind: a.kind,
        intentHash: authority.actions[id].intentHash,
        requestHash: canonicalHash(request),
        predecessor,
        reservedAt: now(),
        phase: "reserved",
        version: 1,
      };
      await write(
        builders.buildReserveIntroductionAction({
          hold,
          authority,
          action,
          now: now(),
          tables,
        }),
      );
      return action;
    },
    async submitOnce(id, context) {
      assertBoundExecution(binding, now());
      const a = actionFor(id),
        previous = await readAction(id),
        request = recipes.request(m, a, context);
      if (
        previous.phase !== "reserved" ||
        previous.requestHash !== canonicalHash(request)
      )
        refuse();
      const submitted = {
        ...previous,
        phase: "submitted",
        version: 2,
        attemptId: randomUUID(),
        submittedAt: now(),
      };
      // Ambiguous persistence never grants dispatch permission, even when a subsequent read matches.
      await transition(previous, submitted);
      let receipt;
      try {
        receipt = recipes.acknowledgment(
          m,
          a,
          await invoke(request.operation, request.input, { maxAttempts: 1 }),
          context,
        );
      } catch {
        return refuse();
      }
      responses.set(id, {
        previous: submitted,
        next: {
          ...submitted,
          phase: "acknowledged",
          version: 3,
          acknowledgment: receipt,
          acknowledgedAt: now(),
        },
      });
      return acknowledge(id);
    },
    async observe(id, input) {
      const previous = await readAction(id);
      if (previous.phase !== "acknowledged") refuse();
      const next = {
        ...previous,
        phase: "observed",
        version: 4,
        observation: recipes.observation(m, actionFor(id), input),
        observedAt: now(),
      };
      await transition(previous, next);
      return next;
    },
  };
}
function createIntroductionJournal(options) {
  return createJournal(options, {
    request: requestFor,
    acknowledgment: acknowledgmentFor,
    observation: observationFor,
  });
}
function createProductionIntroductionJournal(options) {
  return createJournal(
    options,
    require("./production-introduction-recipes.cjs").introductionRecipes(
      options,
    ),
  );
}
function createCoordinatorJournal(options) {
  return createJournal(
    options,
    require("./coordinator-recipes.cjs").coordinatorRecipes(options),
  );
}
module.exports = {
  createCoordinatorJournal,
  createProductionIntroductionJournal,
  createIntroductionJournal,
  requestFor,
  acknowledgmentFor,
  observationFor,
};
