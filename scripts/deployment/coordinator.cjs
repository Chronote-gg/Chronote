#!/usr/bin/env node
"use strict";
const { isDeepStrictEqual } = require("node:util");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { bindingHash } = require("./binding-hash.cjs");
const {
  taskContainer,
  runtimeMode,
  taskDefinitionInput,
  candidateDefinition,
  assertPreparedTaskDefinition,
} = require("./task-definition.cjs");
const {
  CoordinatorFailure,
  awsCli,
  createAwsCaller,
  listServiceTaskArns,
} = require("./coordinator-aws.cjs");
const {
  WARMUP_SECONDS,
  RETIREMENT_SECONDS,
  LEASE_SECONDS,
  RENEWAL_MARGIN_SECONDS,
} = require("./production-capacity.cjs");
const { runCli } = require("./coordinator-cli.cjs");

const { configuration } = require("./coordinator-definition.cjs");
function protocolModules(options) {
  const builders =
    options.builders ??
    require("../../dist/services/deploymentControlTransactions.js");
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  return { builders, types };
}
function createCoordinator(options = {}) {
  const { diagnostic = {}, production } = options;
  if (production)
    require("./production-coordinator.cjs").assertProductionCoordinator(
      production,
    );
  const config = configuration(options.env ?? process.env);
  const callAws = createAwsCaller(options.aws ?? awsCli, diagnostic);
  const aws = async (service, operation, input) => {
    if (
      [
        "update-item",
        "transact-write-items",
        "register-task-definition",
        "update-service",
        "modify-listener",
      ].includes(operation)
    )
      await assertWriter();
    return callAws(service, operation, input);
  };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const { builders, types } = protocolModules(options);
  const tables = {
    deploymentControl: `${config.tablePrefix}DeploymentControlTable`,
    meetingHistory: `${config.tablePrefix}MeetingHistoryTable`,
    activeMeeting: `${config.tablePrefix}ActiveMeetingTable`,
  };
  const same = types.sameRuntimeIdentity;
  const { ready, protectedTask } =
    require("./runtime-proof.cjs").createRuntimeProof({
      aws,
      config,
      types,
      now,
      diagnostic,
    });
  const routing = require("./routing.cjs").createRouting({
    aws,
    config,
    env: options.env ?? process.env,
    production,
    failure: (category, message) => new CoordinatorFailure(category, message),
  });
  const persistRouting = (ctl, value) =>
    phase(ctl, ctl.deployment.phase, { routing: value });
  async function routingAuthority(expected) {
    const current = await control();
    own(current);
    if (
      current.coordinatorExpiresAt <= now() ||
      !isDeepStrictEqual(current.deployment, expected.deployment) ||
      !isDeepStrictEqual(current.servingMembers, expected.servingMembers) ||
      current.servingGeneration !== expected.servingGeneration
    )
      throw new CoordinatorFailure(
        "coordinator_authority_changed",
        "Routing authority changed",
      );
  }
  async function assertWriter() {
    const response = await callAws("dynamodb", "get-item", {
      TableName: tables.deploymentControl,
      Key: marshall({ pk: "ENV", sk: "INTRODUCTION" }),
      ConsistentRead: true,
    });
    if (!response.Item) {
      if (production)
        throw new CoordinatorFailure(
          "introduction_held",
          "Bound introduction hold missing",
        );
      return;
    }
    const hold = types.parseDeploymentControlRecord(unmarshall(response.Item));
    if (hold.deployment.state === "released" && !production) return;
    if (production) return production.guard(await control(), config);
    throw new CoordinatorFailure(
      "introduction_held",
      "Production introduction holds deployment",
    );
  }
  async function assertAcknowledged(purpose) {
    if (production) await production.assertAcknowledged(purpose);
  }
  async function completePromotion(ctl, candidate) {
    if (production) await production.assertAcknowledged("promote");
    const row = await runtime(candidate);
    if (!ready(row, ctl, candidate, ctl.deployment.runtimeMode))
      throw new CoordinatorFailure(
        "application_not_ready",
        "Promoted candidate application readiness must refresh before routing",
      );
    await protectedTask(candidate);
    await protectedTask(ctl.deployment.outgoing);
    const revision = await routing.validate(ctl, await service(), candidate);
    if (ctl.deployment.routing && !ctl.deployment.routing.candidateRevision)
      ctl = await persistRouting(ctl, {
        ...ctl.deployment.routing,
        candidateRevision: revision,
      });
    ctl = await routing.switchTraffic(
      ctl,
      true,
      persistRouting,
      routingAuthority,
    );
    return phase(ctl, "promoted");
  }
  const key = (sk) => marshall({ pk: "ENV", sk });
  async function read(sk) {
    const result = await aws("dynamodb", "get-item", {
      TableName: tables.deploymentControl,
      Key: key(sk),
      ConsistentRead: true,
    });
    return result.Item
      ? types.parseDeploymentControlRecord(unmarshall(result.Item))
      : undefined;
  }
  async function control() {
    const row = await read("CONTROL");
    if (row?.recordType !== "control" || row.runtimeEnvironment !== "ecs")
      throw new CoordinatorFailure(
        "control_incompatible",
        "Compatible ECS control required; activation is a separate reviewed operation",
      );
    diagnostic.knownPhase = row.deployment?.phase ?? "none";
    return row;
  }
  async function save(previous, next) {
    if (production) {
      await assertWriter();
      return production.save(previous, next);
    }
    types.controlRecordSchema.parse(next);
    const values = {
      ":token": previous.coordinatorToken,
      ":epoch": previous.coordinatorEpoch,
      ":expiry": previous.coordinatorExpiresAt,
      ":generation": previous.servingGeneration,
      ":members": previous.servingMembers,
    };
    let condition =
      "coordinatorToken = :token AND coordinatorEpoch = :epoch AND coordinatorExpiresAt = :expiry AND servingGeneration = :generation AND servingMembers = :members";
    if (previous.deployment) {
      condition += " AND deployment = :deployment";
      values[":deployment"] = previous.deployment;
    } else condition += " AND attribute_not_exists(deployment)";
    if (previous.maintenance) {
      condition += " AND maintenance = :maintenance";
      values[":maintenance"] = previous.maintenance;
    } else condition += " AND attribute_not_exists(maintenance)";
    // Recovery cursor and compatible-replacement evidence have independent writers.
    const fields = [
      "coordinatorToken",
      "coordinatorEpoch",
      "coordinatorExpiresAt",
      "deployment",
    ];
    const names = {};
    const assignments = fields.map((field, index) => {
      names[`#field${index}`] = field;
      values[`:next${index}`] = next[field];
      return `#field${index} = :next${index}`;
    });
    let observed;
    try {
      const result = await aws("dynamodb", "update-item", {
        TableName: tables.deploymentControl,
        Key: key("CONTROL"),
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression: condition,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
        ReturnValues: "ALL_NEW",
      });
      observed = types.controlRecordSchema.parse(unmarshall(result.Attributes));
    } catch (error) {
      observed = await control();
      if (
        ![...fields, "servingGeneration", "servingMembers"].every((field) =>
          isDeepStrictEqual(observed[field], next[field]),
        )
      )
        throw error;
    }
    diagnostic.knownPhase = observed.deployment?.phase ?? "none";
    return observed;
  }

  function own(row) {
    const d = row.deployment;
    if (
      !d ||
      row.coordinatorToken !== config.runToken ||
      d.runToken !== config.runToken ||
      ![
        "cluster",
        "service",
        "family",
        "candidateId",
        "image",
        "tablePrefix",
      ].every((field) => d[field] === config[field])
    )
      throw new CoordinatorFailure(
        "coordinator_authority_changed",
        "Deployment ownership or environment mismatch",
      );
    routing.assertInputs(d.routing);
    return d;
  }
  async function renew(row) {
    own(row);
    if (production && row.coordinatorExpiresAt > now() + RENEWAL_MARGIN_SECONDS)
      return production.validateCurrent(row, config);
    return save(row, { ...row, coordinatorExpiresAt: now() + LEASE_SECONDS });
  }
  async function phase(row, value, patch = {}) {
    own(row);
    if (
      production &&
      row.deployment.phase === value &&
      Object.keys(patch).length === 0
    )
      return production.validateCurrent(row, config);
    return save(row, {
      ...row,
      coordinatorExpiresAt: now() + LEASE_SECONDS,
      deployment: {
        ...row.deployment,
        ...patch,
        phase: value,
        updatedAt: now(),
      },
    });
  }
  async function service() {
    const result = await aws("ecs", "describe-services", {
      cluster: config.cluster,
      services: [config.service],
    });
    if (result.failures?.length || result.services?.length !== 1)
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Target service unavailable",
      );
    const value = result.services[0];
    if (
      value.desiredCount !== 1 ||
      value.deploymentController?.type !== "ECS" ||
      (value.deploymentConfiguration?.strategy &&
        value.deploymentConfiguration.strategy !== "ROLLING")
    )
      throw new CoordinatorFailure(
        "configuration_invalid",
        "This coordinator requires the reviewed one-task ECS rolling service",
      );
    return value;
  }
  async function definition(arn) {
    return (
      await aws("ecs", "describe-task-definition", { taskDefinition: arn })
    ).taskDefinition;
  }
  async function tasks() {
    const arns = await listServiceTaskArns(aws, config);
    if (!arns.length) return [];
    const result = await aws("ecs", "describe-tasks", {
      cluster: config.cluster,
      tasks: arns,
    });
    if (result.failures?.length)
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Task identity lookup incomplete",
      );
    return result.tasks;
  }
  async function runtime(identity) {
    const row = await read(`RUNTIME#${identity.instanceId}`);
    if (row?.recordType !== "runtime" || !same(row.identity, identity))
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Exact runtime identity unavailable",
      );
    return row;
  }
  async function original(ctl, svc) {
    const running = await tasks();
    const outgoing = Object.values(ctl.servingMembers).filter((member) =>
      running.some(
        (task) =>
          task.taskArn === member.taskArn &&
          task.taskDefinitionArn === svc.taskDefinition &&
          task.lastStatus === "RUNNING" &&
          task.containers.some(
            (container) => container.imageDigest === member.imageDigest,
          ),
      ),
    );
    if (outgoing.length !== 1 || running.length !== 1)
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Existing deployment is not an unambiguous compatible serving task",
      );
    const oldDefinition = await definition(svc.taskDefinition);
    const latest = await definition(
      production
        ? production.binding.manifest.runtime.continuationDefinition
        : (options.taskTemplate?.arn ?? config.family),
    );
    if (latest.family !== config.family)
      throw new CoordinatorFailure(
        "configuration_invalid",
        "Task family mismatch",
      );
    const mode = runtimeMode(taskContainer(latest, config.tablePrefix));
    if (runtimeMode(taskContainer(oldDefinition, config.tablePrefix)) !== mode)
      throw new CoordinatorFailure(
        "configuration_invalid",
        "Replacement runtime mode mismatch",
      );
    const old = await runtime(outgoing[0]);
    if (
      !ready(old, ctl, outgoing[0], mode) ||
      old.role !== "serving" ||
      old.authorizedGeneration !== ctl.servingGeneration ||
      old.retirementRequest
    )
      throw new CoordinatorFailure(
        "application_not_ready",
        "Existing runtime is not a ready compatible serving owner",
      );
    const nativeProtectionExpiresAt =
      Date.parse((await protectedTask(outgoing[0])).expirationDate) / 1000;
    return { outgoing: outgoing[0], mode, nativeProtectionExpiresAt };
  }
  async function findRegistered() {
    const matches = [];
    let nextToken;
    do {
      const page = await aws("ecs", "list-task-definitions", {
        familyPrefix: config.family,
        status: "ACTIVE",
        sort: "DESC",
        ...(nextToken ? { nextToken } : {}),
      });
      for (const arn of page.taskDefinitionArns) {
        const task = await definition(arn);
        if (task.family !== config.family) continue;
        const container = taskContainer(task, config.tablePrefix);
        if (
          container.image === config.image &&
          container.environment.some(
            (entry) =>
              entry.name === "DEPLOYMENT_CANDIDATE_ID" &&
              entry.value === config.candidateId,
          )
        )
          matches.push(arn);
      }
      nextToken = page.nextToken;
    } while (nextToken);
    if (matches.length > 1)
      throw new CoordinatorFailure(
        "outcome_uncertain",
        "Ambiguous candidate task definitions require recovery",
      );
    return matches[0];
  }
  async function registerProduction(ctl) {
    const m = production.binding.manifest;
    const pinned = await definition(m.runtime.continuationDefinition);
    const actual = taskContainer(pinned, config.tablePrefix);
    const expected = candidateDefinition(
      await definition(m.runtime.candidateDefinition),
      config,
    );
    if (
      pinned.taskDefinitionArn !== m.runtime.continuationDefinition ||
      actual.image !== config.image ||
      actual.stopTimeout !== 120 ||
      actual.environment.filter((v) => v.name === "DEPLOYMENT_CANDIDATE_ID")
        .length !== 1 ||
      actual.environment.find((v) => v.name === "DEPLOYMENT_CANDIDATE_ID")
        .value !== config.candidateId ||
      !isDeepStrictEqual(candidateDefinition(pinned, config), expected)
    )
      throw new CoordinatorFailure(
        "configuration_invalid",
        "Pinned candidate configuration differs",
      );
    return phase(ctl, "preparing", {
      taskDefinition: pinned.taskDefinitionArn,
    });
  }
  async function register(ctl) {
    if (production) return registerProduction(ctl);
    let arn = ctl.deployment.taskDefinition ?? (await findRegistered());
    if (!arn) {
      const latest = await definition(
        options.taskTemplate?.arn ?? config.family,
      );
      if (
        runtimeMode(taskContainer(latest, config.tablePrefix)) !==
        ctl.deployment.runtimeMode
      )
        throw new CoordinatorFailure(
          "configuration_invalid",
          "Task command changed during prepare",
        );
      const prepared = candidateDefinition(latest, config);
      if (
        options.taskTemplate &&
        bindingHash(prepared) !== options.taskTemplate.preparedSha256
      )
        throw new CoordinatorFailure(
          "configuration_invalid",
          "Reviewed task template changed",
        );
      try {
        arn = (await aws("ecs", "register-task-definition", prepared))
          .taskDefinition.taskDefinitionArn;
      } catch (error) {
        arn = await findRegistered();
        if (!arn) throw error;
      }
    }
    if (options.taskTemplate)
      assertPreparedTaskDefinition(
        taskDefinitionInput(await definition(arn)),
        candidateDefinition(await definition(options.taskTemplate.arn), config),
        options.taskTemplate.preparedSha256,
      );
    return phase(ctl, "preparing", { taskDefinition: arn });
  }
  async function launchCandidate(ctl, svc, deploymentConfiguration) {
    if (production) await production.launch(ctl, svc);
    else
      try {
        await aws("ecs", "update-service", {
          cluster: config.cluster,
          service: config.service,
          taskDefinition: ctl.deployment.taskDefinition,
          ...(ctl.deployment.routing
            ? { loadBalancers: routing.binding(ctl.deployment.routing, true) }
            : {}),
          deploymentConfiguration,
        });
      } catch (error) {
        if ((await service()).taskDefinition !== ctl.deployment.taskDefinition)
          throw error;
      }
  }
  async function prepare() {
    await assertWriter();
    let ctl = await control();
    const svc = await service();
    const deploymentConfiguration = {
      ...svc.deploymentConfiguration,
      minimumHealthyPercent: 100,
      maximumPercent: 200,
      earlySuccessCriteria: {
        enable: true,
        healthyPercent: 100,
        sourceServiceRevisionCleanup: "DEFERRED",
      },
    };
    await aws("ecs", "validate-update-service", {
      cluster: config.cluster,
      service: config.service,
      deploymentConfiguration,
    });
    if (ctl.deployment?.runToken === config.runToken) {
      own(ctl);
      if (ctl.deployment.phase !== "preparing") {
        await assertAcknowledged("launch");
        return { kind: "preserved", phase: ctl.deployment.phase };
      }
      ctl = await renew(ctl);
    } else {
      if (
        ctl.coordinatorExpiresAt > now() ||
        (ctl.deployment && ctl.deployment.phase !== "complete")
      )
        throw new CoordinatorFailure(
          "coordinator_authority_changed",
          "Another coordinator or unresolved deployment owns this environment",
        );
      const previous = await original(ctl, svc);
      const traffic = await routing.prepare(svc, previous.outgoing);
      ctl = await save(ctl, {
        ...ctl,
        coordinatorToken: config.runToken,
        coordinatorEpoch: ctl.coordinatorEpoch + 1,
        coordinatorExpiresAt: now() + LEASE_SECONDS,
        deployment: {
          ...config,
          runtimeMode: previous.mode,
          phase: "preparing",
          originalGeneration: ctl.servingGeneration,
          originalMembers: Object.values(ctl.servingMembers),
          outgoing: previous.outgoing,
          previousTaskDefinition: svc.taskDefinition,
          ...(traffic ? { routing: traffic } : {}),
          updatedAt: now(),
        },
      });
    }
    ctl = await register(ctl);
    await protectedTask(ctl.deployment.outgoing);
    ctl = await phase(ctl, "warming");
    await launchCandidate(ctl, svc, deploymentConfiguration);
    const updated = await service();
    if (updated.taskDefinition !== ctl.deployment.taskDefinition)
      throw new CoordinatorFailure(
        "outcome_uncertain",
        "Candidate task definition is unconfirmed",
      );
    if (ctl.deployment.routing)
      routing.assertBinding(updated, ctl.deployment.routing, true);
    return { kind: "warming" };
  }
  async function candidate(ctl) {
    const d = ctl.deployment;
    const running = (await tasks()).filter(
      (task) =>
        task.taskDefinitionArn === d.taskDefinition &&
        task.lastStatus === "RUNNING",
    );
    if (running.length !== 1) return undefined;
    const task = running[0];
    const found = [];
    let start;
    do {
      const page = await aws("dynamodb", "query", {
        TableName: tables.deploymentControl,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :runtime)",
        ExpressionAttributeValues: marshall({
          ":pk": "ENV",
          ":runtime": "RUNTIME#",
        }),
        ConsistentRead: true,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      for (const item of page.Items ?? []) {
        const row = types.runtimeRecordSchema.parse(unmarshall(item));
        if (
          row.identity.kind === "ecs" &&
          row.identity.taskArn === task.taskArn &&
          row.identity.candidateId === config.candidateId &&
          row.identity.imageDigest === config.image.split("@")[1] &&
          task.containers.some(
            (container) => container.imageDigest === row.identity.imageDigest,
          )
        )
          found.push(row);
      }
      start = page.LastEvaluatedKey;
    } while (start);
    if (found.length !== 1) return undefined;
    const row = found[0];
    return row.role === "candidate" &&
      !row.retirementRequest &&
      ready(row, ctl, row.identity, d.runtimeMode)
      ? row
      : undefined;
  }
  function promotionObserved(ctl, target, generation, retained) {
    const expected = [target, ...retained];
    return (
      ctl.servingGeneration === generation &&
      Object.keys(ctl.servingMembers).length === expected.length &&
      expected.every(
        (identity) =>
          ctl.servingMembers[identity.instanceId] &&
          same(ctl.servingMembers[identity.instanceId], identity),
      )
    );
  }
  async function transactPromotion(
    ctl,
    transaction,
    target,
    generation,
    retained,
  ) {
    try {
      await aws("dynamodb", "transact-write-items", transaction);
    } catch (error) {
      const observed = await control();
      own(observed);
      if (!promotionObserved(observed, target, generation, retained))
        throw error;
    }
    const observed = await control();
    own(observed);
    if (!promotionObserved(observed, target, generation, retained))
      throw new CoordinatorFailure(
        "outcome_uncertain",
        "Promotion acknowledgment missing",
      );
    return observed;
  }
  function assertExpectedCandidate(warm) {
    if (
      options.expectedCandidate &&
      !same(warm.identity, options.expectedCandidate)
    )
      throw new CoordinatorFailure(
        "continuation_refused",
        "Reviewed candidate changed",
      );
  }
  async function promoteCandidate(ctl, promotion, identity, retained) {
    return production
      ? await production.promote(ctl, promotion)
      : await transactPromotion(
          ctl,
          builders.buildPromotionTransaction({ ...promotion, tables }),
          identity,
          promotion.proposedGeneration,
          retained,
        );
  }
  async function promote() {
    await assertWriter();
    await assertAcknowledged("launch");
    const deadline = now() + WARMUP_SECONDS;
    while (now() <= deadline) {
      let ctl = await renew(await control());
      const d = ctl.deployment;
      if (["promoted", "retiring", "complete"].includes(d.phase))
        return { kind: d.phase };
      if (!["warming", "promoting"].includes(d.phase))
        throw new CoordinatorFailure(
          "invalid_phase",
          "Prepare must precede promotion",
        );
      const svc = await service();
      if (
        svc.taskDefinition !== d.taskDefinition ||
        !isDeepStrictEqual(svc.deploymentConfiguration?.earlySuccessCriteria, {
          enable: true,
          healthyPercent: 100,
          sourceServiceRevisionCleanup: "DEFERRED",
        })
      )
        throw new CoordinatorFailure(
          "configuration_invalid",
          "Candidate service configuration is not confirmed",
        );
      const retained = d.originalMembers.filter(
        (member) => member.instanceId !== d.outgoing.instanceId,
      );
      if (
        d.candidate &&
        promotionObserved(ctl, d.candidate, d.originalGeneration + 1, retained)
      ) {
        await completePromotion(ctl, d.candidate);
        return { kind: "promoted", recovered: true };
      }
      const warm = await candidate(ctl);
      if (warm) {
        assertExpectedCandidate(warm);
        await protectedTask(d.outgoing);
        await protectedTask(warm.identity);
        const revision = await routing.validate(ctl, svc, warm.identity);
        if (d.routing) await routing.assertAction(d.routing, false);
        ctl = await phase(ctl, "promoting", {
          candidate: warm.identity,
          ...(d.routing
            ? { routing: { ...d.routing, candidateRevision: revision } }
            : {}),
        });
        const promotion = {
          coordinatorToken: config.runToken,
          coordinatorEpoch: ctl.coordinatorEpoch,
          expectedServingGeneration: d.originalGeneration,
          expectedServingMembers: d.originalMembers,
          candidate: warm.identity,
          candidateRuntimeMode: d.runtimeMode,
          retainedMembers: retained,
          proposedGeneration: d.originalGeneration + 1,
          now: now(),
        };
        ctl = await promoteCandidate(ctl, promotion, warm.identity, retained);
        await completePromotion(ctl, warm.identity);
        return { kind: "promoted" };
      }
      await sleep(10000);
    }
    throw new CoordinatorFailure(
      "application_not_ready",
      "Candidate readiness timeout; old admission retained, protected tasks preserved (check DEPLOYMENT_BLOCKED)",
    );
  }
  async function writeRetirement(ctl, row, request, identity) {
    if (production) {
      await assertWriter();
      await production.retirement(ctl, { record: row, request, now: now() });
    } else
      try {
        await aws(
          "dynamodb",
          "transact-write-items",
          builders.buildRuntimeRetirementRequest(
            { record: row, request, now: now() },
            tables,
          ),
        );
      } catch (error) {
        if (
          !isDeepStrictEqual(
            (await runtime(identity)).retirementRequest,
            request,
          )
        )
          throw error;
      }
  }
  async function requestRetirement(ctl, identity, generation) {
    const row = await runtime(identity);
    const request = {
      identity,
      authorizedGeneration: generation,
      coordinatorToken: config.runToken,
      coordinatorEpoch: ctl.coordinatorEpoch,
    };
    if (
      row.retirementRequest &&
      !isDeepStrictEqual(row.retirementRequest, request)
    )
      throw new CoordinatorFailure(
        "outcome_uncertain",
        "Different retirement request requires recovery",
      );
    if (row.retirementRequest) await assertAcknowledged("retirement");
    if (!row.retirementRequest) {
      await writeRetirement(ctl, row, request, identity);
    }
    const observed = await runtime(identity);
    return (
      observed.role === "retired" &&
      observed.authorizedGeneration === generation &&
      isDeepStrictEqual(observed.retirementAcknowledgment?.request, request) &&
      observed.workCounts &&
      Object.values(observed.workCounts).every((count) => count === 0)
    );
  }
  async function retire() {
    await assertWriter();
    const deadline = now() + RETIREMENT_SECONDS;
    while (now() <= deadline) {
      let ctl = await renew(await control());
      const d = ctl.deployment;
      if (d.phase === "complete") return { kind: "complete" };
      if (!["promoted", "retiring"].includes(d.phase))
        throw new CoordinatorFailure(
          "invalid_phase",
          "Exact promotion required before retirement",
        );
      const retained = d.originalMembers.filter(
        (member) => member.instanceId !== d.outgoing.instanceId,
      );
      if (
        !d.candidate ||
        !promotionObserved(ctl, d.candidate, d.originalGeneration + 1, retained)
      )
        throw new CoordinatorFailure(
          "coordinator_authority_changed",
          "Serving membership changed before retirement",
        );
      const active = await runtime(d.candidate);
      if (!ready(active, ctl, d.candidate, d.runtimeMode))
        throw new CoordinatorFailure(
          "application_not_ready",
          "Promoted runtime readiness lost; reconcile before retirement",
        );
      await protectedTask(d.candidate);
      if (d.routing) {
        if (d.routing.state !== "candidate")
          throw new CoordinatorFailure(
            "routing_unconfirmed",
            "Routing acknowledgment required before retirement",
          );
        await routing.assertAction(d.routing, true);
        await routing.serving(ctl, await service());
      }
      ctl = await phase(ctl, "retiring");
      if (await requestRetirement(ctl, d.outgoing, d.originalGeneration)) {
        const svc = await service();
        if (
          svc.taskDefinition === d.taskDefinition &&
          svc.pendingCount === 0 &&
          svc.runningCount === 1 &&
          svc.deployments.length === 1 &&
          svc.deployments[0].rolloutState === "COMPLETED"
        ) {
          await phase(ctl, "complete");
          return { kind: "complete" };
        }
      }
      await sleep(10000);
    }
    throw new CoordinatorFailure(
      "retirement_incomplete",
      "Retirement/convergence incomplete; preserve tasks and request recovery",
    );
  }
  async function rollbackReady(ctl, authorizedGeneration) {
    const d = ctl.deployment;
    const old = await runtime(d.outgoing);
    if (
      old.role !== "serving" ||
      old.authorizedGeneration !== authorizedGeneration ||
      old.retirementRequest ||
      old.retirementAcknowledgment ||
      !ready(old, ctl, d.outgoing, d.runtimeMode)
    )
      return false;
    const source = await runtime(d.candidate);
    if (
      source.expiresAt !== undefined ||
      source.role !== "serving" ||
      source.authorizedGeneration !== d.originalGeneration + 1 ||
      source.retirementRequest ||
      source.retirementAcknowledgment
    )
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Rollback source ownership changed",
      );
    await protectedTask(d.outgoing);
    await protectedTask(d.candidate);
    await routing.validateRollback(ctl, await service());
    return true;
  }
  async function completeRollback(ctl) {
    if (!(await rollbackReady(ctl, ctl.deployment.originalGeneration + 2)))
      return {
        kind: "recovery_required",
        reason: "no_ready_pre_retirement_rollback_target",
      };
    ctl = await routing.switchTraffic(
      ctl,
      false,
      persistRouting,
      routingAuthority,
    );
    await phase(ctl, "rolled_back");
    return {
      kind: "rolled_back",
      candidatePreserved: true,
      recoveryRequired: true,
    };
  }
  async function reconcile() {
    await assertWriter();
    if (production)
      return {
        kind: "recovery_required",
        reason: "production_continuation_required",
      };
    let ctl = await renew(await control());
    const d = ctl.deployment;
    if (d.phase === "complete") return { kind: "complete" };
    if (d.routing?.state.endsWith("_submitted"))
      return {
        kind: "recovery_required",
        reason: "routing_request_settlement_unknown",
        observedRouting: await routing.observe(d.routing),
      };
    const retained = d.originalMembers.filter(
      (member) => member.instanceId !== d.outgoing.instanceId,
    );
    if (
      d.phase === "promoting" &&
      d.candidate &&
      promotionObserved(ctl, d.candidate, d.originalGeneration + 1, retained)
    )
      ctl = await completePromotion(ctl, d.candidate);
    if (!["promoted", "rollback_promoting"].includes(ctl.deployment.phase))
      return { kind: "recovery_required", phase: ctl.deployment.phase };
    if (promotionObserved(ctl, d.outgoing, d.originalGeneration + 2, retained))
      return completeRollback(ctl);
    if (!(await rollbackReady(ctl, d.originalGeneration)))
      return {
        kind: "recovery_required",
        reason: "no_ready_pre_retirement_rollback_target",
      };
    if (d.routing) await routing.assertAction(d.routing, true);
    ctl = await phase(ctl, "rollback_promoting");
    ctl = await transactPromotion(
      ctl,
      builders.buildRollbackPromotionTransaction(ctl, now(), tables),
      d.outgoing,
      d.originalGeneration + 2,
      retained,
    );
    return completeRollback(ctl);
  }

  return {
    prepare,
    promote,
    retire,
    reconcile,
    inspectServing: async () => {
      const ctl = await control();
      const svc = await service();
      const previous = await original(ctl, svc);
      return {
        control: ctl,
        source: previous.outgoing,
        runtimeMode: previous.mode,
        routing: await routing.prepare(svc, previous.outgoing),
        serviceDefinition: svc.taskDefinition,
        service: svc,
        nativeProtectionExpiresAt: previous.nativeProtectionExpiresAt,
      };
    },
    inspectContinuation: async () => {
      if (production) await assertWriter();
      const inspected =
        await require("./continuation-inspection.cjs").inspectContinuation({
          control,
          own,
          service,
          candidate,
          runtime,
          ready,
          protectedTask,
          routing,
        });
      if (production)
        await production.validateCurrent(inspected.control, config);
      return inspected;
    },
  };
}
module.exports = {
  createCoordinator,
  configuration,
  candidateDefinition,
  taskDefinitionInput,
  taskContainer,
  runtimeMode,
  awsCli,
  runCli,
};
if (require.main === module) {
  runCli(process.argv[2]).then((code) => {
    process.exitCode = code;
  });
}
