#!/usr/bin/env node
"use strict";
const { sameEcsTaskArn } = require("../../src/utils/ecsTaskArn.js");
const { execFile } = require("node:child_process");
const { promisify, isDeepStrictEqual } = require("node:util");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const exec = promisify(execFile);
const WARMUP_SECONDS = 900;
const RETIREMENT_SECONDS = 7500;
const PROTECTION_MARGIN_SECONDS = 120;
const CLI_PHASES = ["prepare", "promote", "retire", "reconcile"];

class CoordinatorFailure extends Error {
  constructor(category, message, operation) {
    super(message);
    this.category = category;
    this.operation = operation;
  }
}

async function awsCli(service, operation, input) {
  const validating = operation === "validate-update-service";
  const { stdout } = await exec(
    "aws",
    [
      service,
      validating ? "update-service" : operation,
      "--cli-input-json",
      JSON.stringify(input),
      ...(validating ? ["--generate-cli-skeleton", "input"] : []),
      "--output",
      "json",
      "--no-cli-pager",
    ],
    {
      maxBuffer: 4 * 1024 * 1024,
      // A hidden retry can outlive this call and invalidate the submitted fence.
      ...(service === "elbv2" && operation === "modify-listener"
        ? { env: { ...process.env, AWS_MAX_ATTEMPTS: "1" } }
        : {}),
    },
  );
  const response = stdout.trim() ? JSON.parse(stdout) : {};
  if (validating) {
    // Output skeletons can fail on invalid dummy responses in supported CLI models.
    const criteria = response.deploymentConfiguration?.earlySuccessCriteria;
    if (
      !criteria ||
      !["enable", "healthyPercent", "sourceServiceRevisionCleanup"].every(
        (field) => Object.hasOwn(criteria, field),
      )
    )
      throw new Error(
        "AWS CLI lacks deferred service revision cleanup support",
      );
  }
  return response;
}
function configuration(env) {
  const required = (key) => {
    if (!env[key]?.trim())
      throw new CoordinatorFailure("configuration_invalid", `Missing ${key}`);
    return env[key].trim();
  };
  const prefix = required("SECRETS_PREFIX");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(prefix))
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Invalid SECRETS_PREFIX",
    );
  const tablePrefix = `${prefix}-`;
  if (env.DDB_TABLE_PREFIX && env.DDB_TABLE_PREFIX !== tablePrefix)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "DDB_TABLE_PREFIX mismatch",
    );
  const image = required("CANDIDATE_IMAGE");
  if (!/@sha256:[a-f0-9]{64}$/.test(image))
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Candidate image must pin its digest",
    );
  return {
    cluster: required("ECS_CLUSTER"),
    service: required("ECS_SERVICE"),
    family: required("ECS_TASK_FAMILY"),
    runToken: required("DEPLOYMENT_RUN_TOKEN"),
    candidateId: required("DEPLOYMENT_CANDIDATE_ID"),
    image,
    tablePrefix,
  };
}
function taskContainer(definition, tablePrefix) {
  const matches = definition.containerDefinitions.filter((container) =>
    container.environment?.some((entry) => entry.name === "DDB_TABLE_PREFIX"),
  );
  if (matches.length !== 1)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Expected one protocol container with an explicit table route",
    );
  const container = matches[0];
  const route = container.environment.filter(
    (entry) => entry.name === "DDB_TABLE_PREFIX",
  );
  if (route.length !== 1 || route[0].value !== tablePrefix)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Task table route mismatch",
    );
  return container;
}
function runtimeMode(container) {
  const command = JSON.stringify(container.command ?? ["npx", "yarn", "serve"]);
  const modes = {
    all: [
      ["npx", "yarn", "serve"],
      ["node", "dist/index.js"],
    ],
    bot: [
      ["npx", "yarn", "serve:bot"],
      ["node", "dist/apps/bot/main.js"],
    ],
    api: [
      ["npx", "yarn", "serve:api"],
      ["node", "dist/apps/api/main.js"],
    ],
  };
  if (container.entryPoint?.length)
    throw new CoordinatorFailure(
      "configuration_invalid",
      "Unreviewed task entry point",
    );
  for (const [mode, commands] of Object.entries(modes))
    if (commands.some((value) => JSON.stringify(value) === command))
      return mode;
  throw new CoordinatorFailure(
    "configuration_invalid",
    "Unreviewed task runtime command",
  );
}
function candidateDefinition(definition, config) {
  const next = structuredClone(definition);
  for (const field of [
    "taskDefinitionArn",
    "revision",
    "status",
    "requiresAttributes",
    "compatibilities",
    "registeredAt",
    "registeredBy",
    "deregisteredAt",
  ])
    delete next[field];
  const container = taskContainer(next, config.tablePrefix);
  container.image = config.image;
  container.stopTimeout = 120;
  container.environment = container.environment.filter(
    (entry) => entry.name !== "DEPLOYMENT_CANDIDATE_ID",
  );
  container.environment.push({
    name: "DEPLOYMENT_CANDIDATE_ID",
    value: config.candidateId,
  });
  return next;
}
function createAwsCaller(executeAws, diagnostic) {
  return async function callAws(service, operation, input) {
    const name = `${service}.${operation}`;
    diagnostic.operation = name;
    try {
      return await executeAws(service, operation, input);
    } catch {
      const categories = {
        "ecs.validate-update-service": "cli_capability_unsupported",
        "ecs.get-task-protection": "native_protection_unconfirmed",
      };
      const category =
        categories[name] ??
        (service === "dynamodb"
          ? "control_store_operation_failed"
          : "provider_operation_failed");
      throw new CoordinatorFailure(
        category,
        "Coordinator AWS operation failed",
        name,
      );
    }
  };
}
function protocolModules(options) {
  const builders =
    options.builders ??
    require("../../dist/services/deploymentControlTransactions.js");
  const types =
    options.types ?? require("../../dist/types/deploymentControl.js");
  return { builders, types };
}
function createCoordinator(options = {}) {
  const { diagnostic = {} } = options;
  const config = configuration(options.env ?? process.env);
  const aws = createAwsCaller(options.aws ?? awsCli, diagnostic);
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
  const routing = require("./routing.cjs").createRouting({
    aws,
    config,
    env: options.env ?? process.env,
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
  async function completePromotion(ctl, candidate) {
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
    return save(row, { ...row, coordinatorExpiresAt: now() + 180 });
  }
  async function phase(row, value, patch = {}) {
    own(row);
    return save(row, {
      ...row,
      coordinatorExpiresAt: now() + 180,
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
    const arns = [];
    let nextToken;
    do {
      const page = await aws("ecs", "list-tasks", {
        cluster: config.cluster,
        serviceName: config.service,
        desiredStatus: "RUNNING",
        ...(nextToken ? { nextToken } : {}),
      });
      arns.push(...page.taskArns);
      nextToken = page.nextToken;
    } while (nextToken);
    if (!arns.length) return [];
    if (arns.length > 100)
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "Unexpected task count",
      );
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
  function freshProof(proof, margin = 0) {
    return proof.provenAt <= now() && proof.expiresAt > now() + margin;
  }
  function ready(row, ctl, identity, mode) {
    const r = row?.readiness;
    return (
      row?.recordType === "runtime" &&
      row.expiresAt === undefined &&
      same(row.identity, identity) &&
      same(r.identity, identity) &&
      same(row.protection.identity, identity) &&
      r.runtimeMode === mode &&
      r.observedEpoch === ctl.coordinatorEpoch &&
      r.observedGeneration === ctl.servingGeneration &&
      r.dependenciesReady &&
      r.cacheReady &&
      (mode === "api" || r.gatewayReady) &&
      freshProof(r) &&
      freshProof(row.protection, PROTECTION_MARGIN_SECONDS)
    );
  }
  async function protectedTask(identity) {
    diagnostic.nativeProtection = "unconfirmed";
    if (identity.kind !== "ecs")
      throw new CoordinatorFailure(
        "identity_unconfirmed",
        "ECS identity required",
      );
    const result = await aws("ecs", "get-task-protection", {
      cluster: config.cluster,
      tasks: [identity.taskArn],
    });
    diagnostic.operation = "verify_native_protection";
    const proof = result.protectedTasks?.find((task) =>
      sameEcsTaskArn(task.taskArn, identity.taskArn),
    );
    if (
      result.failures?.length ||
      !proof?.protectionEnabled ||
      !Number.isFinite(Date.parse(proof.expirationDate)) ||
      Date.parse(proof.expirationDate) / 1000 <=
        now() + PROTECTION_MARGIN_SECONDS
    )
      throw new CoordinatorFailure(
        "native_protection_unconfirmed",
        "Native task protection unconfirmed; preserve work and investigate capacity/DEPLOYMENT_BLOCKED",
      );
    diagnostic.nativeProtection = "last_check_confirmed";
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
    const latest = await definition(config.family);
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
    await protectedTask(outgoing[0]);
    return { outgoing: outgoing[0], mode };
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
  async function register(ctl) {
    let arn = ctl.deployment.taskDefinition ?? (await findRegistered());
    if (!arn) {
      const latest = await definition(config.family);
      if (
        runtimeMode(taskContainer(latest, config.tablePrefix)) !==
        ctl.deployment.runtimeMode
      )
        throw new CoordinatorFailure(
          "configuration_invalid",
          "Task command changed during prepare",
        );
      try {
        arn = (
          await aws(
            "ecs",
            "register-task-definition",
            candidateDefinition(latest, config),
          )
        ).taskDefinition.taskDefinitionArn;
      } catch (error) {
        arn = await findRegistered();
        if (!arn) throw error;
      }
    }
    return phase(ctl, "preparing", { taskDefinition: arn });
  }
  async function prepare() {
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
      if (ctl.deployment.phase !== "preparing")
        return { kind: "preserved", phase: ctl.deployment.phase };
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
        coordinatorExpiresAt: now() + 180,
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
  async function promote() {
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
        const transaction = builders.buildPromotionTransaction({
          tables,
          coordinatorToken: config.runToken,
          coordinatorEpoch: ctl.coordinatorEpoch,
          expectedServingGeneration: d.originalGeneration,
          expectedServingMembers: d.originalMembers,
          candidate: warm.identity,
          candidateRuntimeMode: d.runtimeMode,
          retainedMembers: retained,
          proposedGeneration: d.originalGeneration + 1,
          now: now(),
        });
        ctl = await transactPromotion(
          ctl,
          transaction,
          warm.identity,
          d.originalGeneration + 1,
          retained,
        );
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
    if (!row.retirementRequest) {
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

  return { prepare, promote, retire, reconcile };
}
async function runCli(requestedPhase, options = {}, output = console) {
  const diagnostic = {
    requestedPhase: CLI_PHASES.includes(requestedPhase)
      ? requestedPhase
      : "invalid",
    knownPhase: "unknown",
    operation: "configuration",
    nativeProtection: "not_checked",
  };
  try {
    if (!CLI_PHASES.includes(requestedPhase))
      throw new CoordinatorFailure(
        "invalid_phase",
        "Expected a coordinator phase",
        "arguments",
      );
    const coordinator = createCoordinator({ ...options, diagnostic });
    const result = await coordinator[requestedPhase]();
    output.log(JSON.stringify(result));
    return result.kind === "recovery_required" || result.recoveryRequired
      ? 1
      : 0;
  } catch (error) {
    output.error(
      JSON.stringify({
        kind: "deployment_failed",
        ...diagnostic,
        operation:
          error instanceof CoordinatorFailure
            ? (error.operation ?? diagnostic.operation)
            : diagnostic.operation,
        category:
          error instanceof CoordinatorFailure
            ? error.category
            : "state_validation_failed",
        taskAction: "no_stop_or_unprotect_requested",
      }),
    );
    return 1;
  }
}
module.exports = {
  createCoordinator,
  configuration,
  candidateDefinition,
  runtimeMode,
  awsCli,
  runCli,
};
if (require.main === module) {
  runCli(process.argv[2]).then((code) => {
    process.exitCode = code;
  });
}
