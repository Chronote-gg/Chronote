"use strict";
const { isDeepStrictEqual } = require("node:util");
const { canonicalHash } = require("./production-manifest.cjs");
const { action: routingAction, canonical } = require("./routing.cjs");
function refuse() {
  throw new Error("coordinator_recipe_refused");
}
function coordinatorRecipes(options) {
  const builders =
    options.coordinatorBuilders ??
    require("../../dist/services/productionCoordinatorTransactions.js");
  const scope = {
    hold: options.hold,
    authority: options.authority,
    table: options.table,
    meetingHistory: options.binding.manifest.resources.tables.meetingHistory,
  };
  function controlRequest(m, a, c) {
    const ctl = c.control,
      next = c.next,
      now = options.now();
    if (
      next.deployment.phase !== a.toPhase ||
      next.coordinatorExpiresAt <= now ||
      next.coordinatorExpiresAt > now + 180 ||
      next.coordinatorExpiresAt >= m.validUntil
    )
      refuse();
    if (a.purpose === "acquire") {
      if (
        ctl.coordinatorExpiresAt !== 0 ||
        ctl.coordinatorToken === next.coordinatorToken
      )
        refuse();
    } else if (
      ctl.coordinatorExpiresAt <= now ||
      ctl.coordinatorToken !== next.coordinatorToken
    )
      refuse();
    const unchanged = isDeepStrictEqual(next.deployment, ctl.deployment);
    if (
      (a.purpose === "renew" && !unchanged) ||
      (a.purpose === "phase" && unchanged)
    )
      refuse();
    return {
      operation: "transactWriteItems",
      input: builders.buildCoordinatorControlSave(scope, ctl, next),
    };
  }
  function request(m, a, c) {
    const ctl = c.control;
    if (
      a.kind !== "coordinator_write" ||
      ctl.coordinatorEpoch !== a.epoch ||
      ctl.servingGeneration !== a.generation ||
      (ctl.deployment?.phase ?? "none") !== a.fromPhase
    )
      refuse();
    if (["acquire", "renew", "phase"].includes(a.purpose))
      return controlRequest(m, a, c);
    if (a.purpose === "promote")
      return {
        operation: "transactWriteItems",
        input: builders.buildCoordinatorPromotion(scope, c.promotion),
      };
    if (a.purpose === "retirement")
      return {
        operation: "transactWriteItems",
        input: builders.buildCoordinatorRetirement(scope, c.retirement),
      };
    return providerRequest(m, a, c);
  }
  function providerRequest(m, a, c) {
    const ctl = c.control;
    const r = ctl.deployment.routing;
    if (a.purpose === "route") {
      if (
        r.listenerArn !== m.resources.listenerArn ||
        ![m.resources.targetGroupA, m.resources.targetGroupB].includes(
          r.candidateGroup,
        ) ||
        r.sourceGroup === r.candidateGroup
      )
        refuse();
      return {
        operation: "modifyListener",
        input: {
          ListenerArn: r.listenerArn,
          DefaultActions: routingAction(r, true),
        },
      };
    }
    if (
      a.purpose !== "launch" ||
      ctl.deployment.taskDefinition !== m.runtime.continuationDefinition ||
      c.service.serviceArn !== m.runtime.serviceArn ||
      c.service.desiredCount !== 1
    )
      refuse();
    return {
      operation: "updateService",
      input: {
        cluster: m.runtime.clusterArn,
        service: m.runtime.serviceArn,
        taskDefinition: m.runtime.continuationDefinition,
        ...(r
          ? {
              loadBalancers: [
                {
                  targetGroupArn: r.candidateGroup,
                  containerName: r.containerName,
                  containerPort: r.containerPort,
                },
              ],
            }
          : {}),
        deploymentConfiguration: {
          ...c.service.deploymentConfiguration,
          minimumHealthyPercent: 100,
          maximumPercent: 200,
          earlySuccessCriteria: {
            enable: true,
            healthyPercent: 100,
            sourceServiceRevisionCleanup: "DEFERRED",
          },
        },
      },
    };
  }
  function acknowledgment(m, a, response, context, wire) {
    const validators = {
      updateService() {
        if (
          response?.service?.serviceArn !== m.runtime.serviceArn ||
          response.service.taskDefinition !==
            m.runtime.continuationDefinition ||
          response.service.desiredCount !== 1
        )
          refuse();
      },
      modifyListener() {
        if (
          response?.Listeners?.length !== 1 ||
          response.Listeners[0].ListenerArn !== wire.input.ListenerArn ||
          !isDeepStrictEqual(
            canonical(response.Listeners[0].DefaultActions),
            canonical(wire.input.DefaultActions),
          )
        )
          refuse();
      },
      transactWriteItems() {
        if (!response || response.UnprocessedItems) refuse();
      },
    };
    validators[wire.operation]();
    return {
      resourceIds: [options.table],
      ...(a.purpose === "promote"
        ? {
            facts: {
              kind: "promotion",
              control: context.control,
              ...context.historicalPromotion,
            },
          }
        : a.purpose === "route"
          ? {
              facts: {
                kind: "route",
                listenerArn: wire.input.ListenerArn,
                targetGroupArn:
                  context.control.deployment.routing.candidateGroup,
              },
            }
          : {}),
      evidenceHash: canonicalHash({
        request: wire,
        directAcknowledgment: true,
      }),
    };
  }
  function observation(m, a, input) {
    const expected = {
      epoch: a.purpose === "acquire" ? a.epoch + 1 : a.epoch,
      generation: a.purpose === "promote" ? a.generation + 1 : a.generation,
      phase: a.toPhase,
    };
    const { facts, ...state } = input;
    if (!isDeepStrictEqual(state, expected)) refuse();
    return {
      resourceIds: [options.table],
      evidenceHash: canonicalHash(input),
      ...(facts ? { facts } : {}),
    };
  }
  return { request, acknowledgment, observation };
}
module.exports = { coordinatorRecipes };
