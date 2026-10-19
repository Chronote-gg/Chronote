"use strict";
const { isDeepStrictEqual } = require("node:util");
const { assertBoundExecution } = require("./production-manifest.cjs");
const {
  createIntroductionHold,
  assertMutationAllowed,
  modules,
} = require("./introduction-hold.cjs");
const { createCoordinatorJournal } = require("./introduction-transitions.cjs");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const capabilities = new WeakSet();
function refuse() {
  throw new CoordinatorFailure(
    "introduction_recovery_required",
    "Exact acknowledged introduction authority required",
  );
}
function assertProductionCoordinator(value) {
  if (!capabilities.has(value)) refuse();
}
function createProductionCoordinator(options) {
  const { binding, read, now } = options;
  const m = assertBoundExecution(binding, now()),
    builders = modules(options);
  const holdApi = createIntroductionHold(options);
  let sequence = [];
  const actionKey = (id) => ({
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: `ACTION#${id}`,
  });
  const fixtureKey = {
    pk: `INTRODUCTION#${m.introductionId}`,
    sk: "FIXTURE_COORDINATOR",
  };
  let journal;
  function assertConfig(config) {
    if (
      config.runToken !== m.handoff.runToken ||
      config.candidateId !== m.handoff.candidateId ||
      config.cluster !== m.runtime.clusterArn ||
      config.service !== m.runtime.serviceArn ||
      config.family !== m.runtime.family ||
      `${config.tablePrefix}DeploymentControlTable` !==
        m.resources.tables.deploymentControl ||
      config.image.split("@")[1] !== m.runtime.continuationDigest
    )
      refuse();
  }
  async function settleRows(control) {
    for (const a of m.actions) {
      const row = await read(actionKey(a.actionId));
      if (row) await journal.readAction(a.actionId);
      if (
        row?.phase === "acknowledged" &&
        a.kind === "coordinator_write" &&
        a.purpose === "route"
      ) {
        await options.assertCandidateRoute(control.deployment.routing);
        await journal.observe(a.actionId, {
          epoch: control.coordinatorEpoch,
          generation: control.servingGeneration,
          phase: control.deployment.phase,
        });
      } else if (row && ["submitted", "acknowledged"].includes(row.phase))
        refuse();
    }
  }
  async function guard(control, config) {
    assertBoundExecution(binding, now());
    assertConfig(config);
    const { hold, authority } = await holdApi.readState(binding);
    const fixture = builders.fixtureCoordinatorAuthoritySchema.parse(
      await read(fixtureKey),
    );
    const path =
      fixture.priorEpoch === m.handoff.priorEpoch ? "normal" : "replacement";
    sequence = m.actions.filter(
      (a) => a.kind === "coordinator_write" && (a.path ?? "normal") === path,
    );
    if (
      fixture.manifestHash !== binding.manifestHash ||
      fixture.holdId !== hold.holdId ||
      fixture.runToken !== config.runToken ||
      fixture.candidateId !== config.candidateId ||
      fixture.taskDefinition !== m.runtime.continuationDefinition ||
      fixture.imageDigest !== m.runtime.continuationDigest
    )
      refuse();
    if (control.coordinatorToken !== config.runToken)
      assertMutationAllowed({
        builders,
        hold,
        operationAuthority: fixture,
        currentControl: control,
        requestedAction: {
          kind: "fixture_coordinator",
          runToken: config.runToken,
          candidateId: config.candidateId,
          taskDefinition: m.runtime.continuationDefinition,
          imageDigest: m.runtime.continuationDigest,
        },
        now: now(),
      });
    else if (
      control.coordinatorEpoch !== fixture.priorEpoch + 1 ||
      !isDeepStrictEqual(control.maintenance, {
        holdId: hold.holdId,
        introductionId: hold.introductionId,
        revision: hold.revision,
      })
    )
      refuse();
    journal ??= createCoordinatorJournal({ ...options, hold, authority });
    await settleRows(control);
  }
  function matchesAction(a, purpose, context) {
    const phase = context.control.deployment?.phase;
    return (
      a.purpose === purpose &&
      a.fromPhase === (phase ?? "none") &&
      a.epoch === context.control.coordinatorEpoch &&
      a.generation === context.control.servingGeneration &&
      a.toPhase === (context.next?.deployment?.phase ?? phase)
    );
  }
  async function selectAction(purpose, context) {
    let selected;
    const reserved = [];
    const observed = new Set();
    for (const a of m.actions) {
      const raw = await read(actionKey(a.actionId));
      const row = raw ? await journal.readAction(a.actionId) : undefined;
      if (row?.phase === "observed") observed.add(a.actionId);
      if (row?.phase === "reserved") reserved.push(a.actionId);
      if (row && ["submitted", "acknowledged"].includes(row.phase)) refuse();
      if (
        sequence.includes(a) &&
        !selected &&
        (!row || row.phase === "reserved") &&
        matchesAction(a, purpose, context)
      )
        selected = { action: a, row };
    }
    assertPrecedingActions(selected, observed, reserved);
    return selected;
  }
  function assertPrecedingActions(selected, observed, reserved) {
    if (!selected || reserved.some((id) => id !== selected.action.actionId))
      refuse();
    if (
      sequence
        .slice(0, sequence.indexOf(selected.action))
        .some((a) => a.purpose !== "renew" && !observed.has(a.actionId))
    )
      refuse();
  }
  async function submit(purpose, context) {
    if (!journal) refuse();
    const selected = await selectAction(purpose, context);
    if (!selected.row)
      await journal.reserveAction(selected.action.actionId, context);
    await journal.submitOnce(selected.action.actionId, context);
    return selected.action;
  }
  const control = () => read({ pk: "ENV", sk: "CONTROL" });
  async function finish(a, observed) {
    await journal.observe(a.actionId, {
      epoch: observed.coordinatorEpoch,
      generation: observed.servingGeneration,
      phase: observed.deployment.phase,
    });
    return observed;
  }
  const api = {
    binding,
    guard,
    async validateCurrent(expected, config) {
      const current = await control();
      await guard(current, config);
      if (
        !isDeepStrictEqual(current, expected) ||
        current.coordinatorExpiresAt <= now()
      )
        refuse();
      for (const a of m.actions) {
        const row = await read(actionKey(a.actionId));
        if (row && row.phase !== "observed") refuse();
      }
      return current;
    },
    async assertAcknowledged(purpose) {
      const actions = sequence.filter((a) => a.purpose === purpose);
      for (const a of actions) {
        const row = await read(actionKey(a.actionId));
        if (row?.phase === "observed") {
          await journal.readAction(a.actionId);
          return;
        }
      }
      refuse();
    },
    async save(previous, next) {
      const purpose =
        previous.coordinatorToken !== next.coordinatorToken
          ? "acquire"
          : isDeepStrictEqual(previous.deployment, next.deployment)
            ? "renew"
            : "phase";
      const a = await submit(purpose, { control: previous, next });
      const observed = await control();
      if (
        ![
          "coordinatorToken",
          "coordinatorEpoch",
          "coordinatorExpiresAt",
          "deployment",
          "servingMembers",
          "servingGeneration",
          "maintenance",
        ].every((key) => isDeepStrictEqual(observed[key], next[key]))
      )
        refuse();
      return finish(a, observed);
    },
    async launch(ctl, service) {
      const a = await submit("launch", { control: ctl, service });
      const observed = await options.readService();
      if (
        observed.serviceArn !== m.runtime.serviceArn ||
        observed.taskDefinition !== m.runtime.continuationDefinition ||
        observed.desiredCount !== 1 ||
        !isDeepStrictEqual(
          observed.deploymentConfiguration?.earlySuccessCriteria,
          {
            enable: true,
            healthyPercent: 100,
            sourceServiceRevisionCleanup: "DEFERRED",
          },
        ) ||
        (ctl.deployment.routing &&
          !isDeepStrictEqual(observed.loadBalancers, [
            {
              targetGroupArn: ctl.deployment.routing.candidateGroup,
              containerName: ctl.deployment.routing.containerName,
              containerPort: ctl.deployment.routing.containerPort,
            },
          ]))
      )
        refuse();
      await finish(a, await control());
    },
    async promote(ctl, promotion) {
      const a = await submit("promote", { control: ctl, promotion });
      const observed = await control();
      if (
        !isDeepStrictEqual(observed.servingMembers, {
          [promotion.candidate.instanceId]: promotion.candidate,
        }) ||
        observed.servingGeneration !== promotion.proposedGeneration
      )
        refuse();
      return finish(a, observed);
    },
    async retirement(ctl, retirement) {
      const a = await submit("retirement", { control: ctl, retirement });
      const row = await read({
        pk: "ENV",
        sk: `RUNTIME#${retirement.record.identity.instanceId}`,
      });
      if (!isDeepStrictEqual(row.retirementRequest, retirement.request))
        refuse();
      await finish(a, await control());
    },
    async route(ctl) {
      const a = await submit("route", { control: ctl });
      await options.assertCandidateRoute(ctl.deployment.routing);
      await finish(a, await control());
    },
  };
  capabilities.add(api);
  return api;
}
module.exports = { createProductionCoordinator, assertProductionCoordinator };
