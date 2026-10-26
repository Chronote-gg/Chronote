"use strict";
const { sameEcsTaskArn } = require("../../src/utils/ecsTaskArn.js");
const assert = require("node:assert/strict");
const { isDeepStrictEqual: same } = require("node:util");
const { setTimeout: pause } = require("node:timers/promises");
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { z } = require("zod");
const { parseManifest, awsCaller } = require("./sandbox-manifest.cjs");
const { action, canonical } = require("./routing.cjs");
const {
  bindJob,
  prepare,
  assertSourceImage,
} = require("./prepare-sandbox.cjs");
const { listServiceTaskArns } = require("./service-task-inventory.cjs");
const uuid = z.string().uuid();
function createIntroduction(options) {
  const m = parseManifest(options.manifest, options.expectedSha256);
  const aws = options.aws ?? awsCaller(m.region);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const sleep = options.pause ?? (() => pause(5000));
  const table = m.tablePrefix + "DeploymentControlTable";
  const bootstrap =
    options.bootstrap ??
    require("./bootstrap-sandbox.cjs").createBootstrap(options);
  const routing = {
    sourceGroup: m.targetGroupA,
    candidateGroup: m.targetGroupB,
  };
  async function read(sk = "INTRODUCTION") {
    const result = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: marshall({ pk: "ENV", sk }),
      ConsistentRead: true,
    });
    return result.Item ? unmarshall(result.Item) : undefined;
  }
  function stageUpdate(from, to, sk = "INTRODUCTION") {
    return {
      TableName: table,
      Key: marshall({ pk: "ENV", sk }),
      ConditionExpression:
        "operationId = :op AND manifestSha256 = :hash AND #stage = :from",
      UpdateExpression: "SET #stage = :next",
      ExpressionAttributeNames: { "#stage": "stage" },
      ExpressionAttributeValues: marshall({
        ":op": m.operationId,
        ":hash": options.expectedSha256,
        ":from": from,
        ":next": to,
      }),
    };
  }
  async function stage(from, to, sk = "INTRODUCTION") {
    await aws("dynamodb", "update-item", stageUpdate(from, to, sk));
  }
  async function count(TableName, extra = {}) {
    let ExclusiveStartKey,
      total = 0;
    do {
      const page = await aws("dynamodb", "scan", {
        TableName,
        ConsistentRead: true,
        Select: "COUNT",
        ...extra,
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      total += page.Count;
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return total;
  }
  async function workSettled() {
    // shortcut: first activation requires empty work tables, add terminal-job handling before reusing it with retained jobs.
    for (const name of [
      "ActiveMeetingTable",
      "MeetingControlCommandTable",
      "PersonalMediaUploadJobTable",
    ]) {
      assert.equal(await count(m.tablePrefix + name), 0, "Work remains");
    }
    assert.equal(
      await count(m.tablePrefix + "MeetingHistoryTable", {
        FilterExpression:
          "attribute_not_exists(#s) OR NOT (#s IN (:complete,:cancelled))",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: marshall({
          ":complete": "complete",
          ":cancelled": "cancelled",
        }),
      }),
      0,
      "Unknown or nonterminal history remains",
    );
  }
  async function service() {
    const result = await aws("ecs", "describe-services", {
      cluster: m.cluster,
      services: [m.service],
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.services.length, 1);
    const value = result.services[0];
    assert.equal(value.serviceName, m.service);
    assert.deepEqual(value.loadBalancers, [
      {
        targetGroupArn: m.targetGroupA,
        containerName: m.containerName,
        containerPort: m.containerPort,
      },
    ]);
    return value;
  }
  async function listener() {
    const result = await aws("elbv2", "describe-listeners", {
      ListenerArns: [m.listenerArn],
    });
    assert.equal(result.Listeners.length, 1);
    const value = result.Listeners[0];
    assert.equal(value.ListenerArn, m.listenerArn);
    assert.equal(value.Protocol, "HTTPS");
    const rules = await aws("elbv2", "describe-rules", {
      ListenerArn: m.listenerArn,
    });
    assert(!rules.NextMarker);
    assert.equal(rules.Rules.length, 1);
    assert.equal(rules.Rules[0].IsDefault, true);
    return value;
  }
  async function targets(group) {
    return (
      await aws("elbv2", "describe-target-health", { TargetGroupArn: group })
    ).TargetHealthDescriptions;
  }
  async function taskInventory() {
    const all = await listServiceTaskArns(aws, m);
    const inventory = [];
    for (let i = 0; i < all.length; i += 100) {
      const batch = all.slice(i, i + 100);
      const response = await aws("ecs", "describe-tasks", {
        cluster: m.cluster,
        tasks: batch,
      });
      assert.deepEqual(response.failures, []);
      assert.equal(response.tasks.length, batch.length);
      inventory.push(...response.tasks);
    }
    return inventory;
  }
  async function liveTasks() {
    return (await taskInventory()).filter(
      (task) => task.lastStatus !== "STOPPED",
    );
  }
  async function assertRepairTargets() {
    const inventory = await taskInventory();
    for (const task of inventory.filter(
      (task) => task.lastStatus !== "STOPPED",
    )) {
      assert.equal(task.taskDefinitionArn, m.legacyTaskDefinition);
      if (task.lastStatus === "DEPROVISIONING") {
        // ECS can retain protection while cleaning up a task whose containers exited.
        assert.equal(task.desiredStatus, "STOPPED");
        assert(task.containers.length > 0);
        assert(task.containers.every((c) => c.lastStatus === "STOPPED"));
        continue;
      }
      const protection = await aws("ecs", "get-task-protection", {
        cluster: m.cluster,
        tasks: [task.taskArn],
      });
      assert.deepEqual(protection.failures, []);
      assert.equal(protection.protectedTasks.length, 1);
      assert(
        sameEcsTaskArn(protection.protectedTasks[0].taskArn, task.taskArn),
      );
      assert.equal(protection.protectedTasks[0].protectionEnabled, false);
    }
    for (const target of await targets(m.targetGroupA)) {
      assert.equal(target.Target.Port, m.containerPort);
      assert(
        inventory.some(
          (task) =>
            task.taskDefinitionArn === m.legacyTaskDefinition &&
            (!["STOPPED", "DEPROVISIONING"].includes(task.lastStatus) ||
              target.TargetHealth.State === "draining") &&
            task.containers.some(
              (container) =>
                container.name === m.containerName &&
                container.networkInterfaces?.length === 1 &&
                container.networkInterfaces[0].privateIpv4Address ===
                  target.Target.Id,
            ),
        ),
        "Group A contains an unowned target",
      );
    }
  }
  async function assertLegacyTarget() {
    const tasks = await liveTasks();
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.lastStatus, "RUNNING");
    assert.equal(task.taskDefinitionArn, m.legacyTaskDefinition);
    const container = task.containers.find((c) => c.name === m.containerName);
    assert.equal(container.networkInterfaces.length, 1);
    const health = await targets(m.targetGroupA);
    assert.equal(health.length, 1);
    assert.equal(
      health[0].Target.Id,
      container.networkInterfaces[0].privateIpv4Address,
    );
    assert.equal(health[0].Target.Port, m.containerPort);
    assert.equal(health[0].TargetHealth.State, "healthy");
    const protection = await aws("ecs", "get-task-protection", {
      cluster: m.cluster,
      tasks: [task.taskArn],
    });
    assert(!protection.failures?.length);
    assert.equal(protection.protectedTasks.length, 1);
    assert(sameEcsTaskArn(protection.protectedTasks[0].taskArn, task.taskArn));
    assert.equal(protection.protectedTasks[0].protectionEnabled, false);
  }
  function stopBudget() {
    const confirmedAt = Date.parse(m.maintenance.confirmedAt) / 1000;
    const current = now();
    // Reserve eight minutes for shutdown and two for routing/initialization.
    assert(
      confirmedAt <= current && confirmedAt + 900 - current >= 600,
      "Maintenance proof has insufficient remaining lifetime",
    );
  }
  async function wait(check, { complete, timeoutSeconds = 900 } = {}) {
    const deadline = now() + timeoutSeconds;
    for (let i = 0; i < 180; i++) {
      if (now() >= deadline) break;
      const ready = await check();
      if (now() >= deadline) break;
      if (!ready) {
        await sleep();
        continue;
      }
      if (!complete) return;
      try {
        return await complete(deadline);
      } catch (error) {
        // This code is emitted only by promotion checks before any write.
        if (error.code !== "candidate_not_ready") throw error;
      }
      await sleep();
    }
    throw new Error("Bounded wait expired; preserve operation");
  }
  async function waitForStoppedService() {
    await wait(
      async () => {
        const current = await service();
        assert.equal(current.taskDefinition, m.legacyTaskDefinition);
        assert.equal(current.desiredCount, 0);
        return (
          current.runningCount === 0 &&
          current.pendingCount === 0 &&
          (await liveTasks()).length === 0 &&
          (await targets(m.targetGroupA)).length === 0 &&
          (await targets(m.targetGroupB)).length === 0
        );
      },
      { timeoutSeconds: 480 },
    );
  }
  async function runtimeReady() {
    const response = await aws("dynamodb", "get-item", {
      TableName: table,
      Key: marshall({ pk: "ENV", sk: "CONTROL" }),
      ConsistentRead: true,
    });
    const control = unmarshall(response.Item);
    assert.equal(control.coordinatorToken, m.operationId);
    assert.equal(control.servingGeneration, 1);
    const members = Object.values(control.servingMembers);
    assert.equal(members.length, 1);
    assert.equal(members[0].candidateId, m.operationId);

    let ExclusiveStartKey,
      matches = [];
    do {
      const page = await aws("dynamodb", "scan", {
        TableName: table,
        ConsistentRead: true,
        ProjectionExpression: "#recordType, #identity, #role, #readiness",
        ExpressionAttributeNames: {
          "#recordType": "recordType",
          "#identity": "identity",
          "#role": "role",
          "#readiness": "readiness",
        },
        ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
      });
      matches.push(
        ...(page.Items ?? [])
          .map(unmarshall)
          .filter(
            (row) =>
              row.recordType === "runtime" && same(row.identity, members[0]),
          ),
      );
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    assert(matches.length <= 1);
    const row = matches[0],
      proof = row?.readiness;
    return (
      row?.role === "serving" &&
      proof?.cacheReady &&
      proof.dependenciesReady &&
      (m.runtimeMode === "api" || proof.gatewayReady) &&
      proof.observedGeneration === 1 &&
      proof.provenAt <= now() &&
      proof.expiresAt > now()
    );
  }
  async function assertCandidateDefinition() {
    const definition = (
      await aws("ecs", "describe-task-definition", {
        taskDefinition: m.taskDefinition,
      })
    ).taskDefinition;
    require("./bootstrap-sandbox.cjs").assertPreparedCandidate(m, definition);
    await assertSourceImage(
      m,
      definition.containerDefinitions.find((c) => c.name === m.containerName)
        .image,
      aws,
    );
  }
  async function activate() {
    const actor = await aws("sts", "get-caller-identity", {});
    assert.equal(actor.Account, m.accountId);
    assert.equal(actor.Arn, m.principalArn);
    if (await read()) return completeIntroduction();
    assert(
      now() >= Date.parse(m.maintenance.confirmedAt) / 1000 &&
        now() - Date.parse(m.maintenance.confirmedAt) / 1000 <= 900,
    );
    assert.equal(await count(table), 0, "Existing ownership cannot be adopted");
    const original = await service();
    assert.equal(original.desiredCount, 1);
    assert.equal(original.runningCount, 1);
    assert.equal(original.pendingCount, 0);
    assert.equal(original.taskDefinition, m.legacyTaskDefinition);
    await workSettled();
    await assertCandidateDefinition();
    const before = await listener();
    const actions = before.DefaultActions;
    assert.equal(actions.length, 1);
    assert.equal(actions[0].Type, "forward");
    assert.equal(actions[0].TargetGroupArn, m.targetGroupA);
    assert(
      Object.keys(actions[0]).every((k) =>
        ["Type", "Order", "TargetGroupArn", "ForwardConfig"].includes(k),
      ),
    );
    if (actions[0].ForwardConfig !== undefined) {
      assert.deepEqual(actions[0].ForwardConfig.TargetGroups, [
        { TargetGroupArn: m.targetGroupA, Weight: 1 },
      ]);
      assert.equal(
        actions[0].ForwardConfig.TargetGroupStickinessConfig.Enabled,
        false,
      );
    }
    await require("./bootstrap-sandbox.cjs").assertTargetGroups(
      m,
      aws,
      before,
      true,
    );
    assert.equal((await targets(m.targetGroupB)).length, 0);
    await assertLegacyTarget();
    stopBudget();
    await aws("dynamodb", "transact-write-items", {
      TransactItems: [
        {
          ConditionCheck: {
            TableName: table,
            Key: marshall({ pk: "ENV", sk: "CONTROL" }),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: table,
            Item: marshall({
              pk: "ENV",
              sk: "INTRODUCTION",
              operationId: m.operationId,
              manifestSha256: options.expectedSha256,
              principalArn: m.principalArn,
              stage: "reserved",
            }),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    await stage("reserved", "stop_submitted");
    await assertLegacyTarget();
    stopBudget();
    const stopped = (
      await aws("ecs", "update-service", {
        cluster: m.cluster,
        service: m.service,
        desiredCount: 0,
      })
    ).service;
    assert.equal(stopped.serviceName, m.service);
    assert.equal(stopped.taskDefinition, m.legacyTaskDefinition);
    assert.equal(stopped.desiredCount, 0);
    await stage("stop_submitted", "stop_acknowledged");
    await waitForStoppedService();
    await workSettled();
    assert(
      same((await listener()).DefaultActions, before.DefaultActions),
      "Listener writer changed",
    );
    await stage("stop_acknowledged", "routing_submitted");
    const changed = await aws("elbv2", "modify-listener", {
      ListenerArn: m.listenerArn,
      DefaultActions: action(routing, false),
    });
    assert.equal(changed.Listeners.length, 1);
    assert.equal(changed.Listeners[0].ListenerArn, m.listenerArn);
    assert.deepEqual(
      canonical(changed.Listeners[0].DefaultActions),
      canonical(action(routing, false)),
    );
    assert.deepEqual(
      canonical((await listener()).DefaultActions),
      canonical(action(routing, false)),
    );
    await stage("routing_submitted", "routing_acknowledged");
    await bootstrap.initialize();
    return finish();
  }
  async function finish(complete = () => completeIntroduction()) {
    await bootstrap.launch();
    const result = await wait(
      async () => (await bootstrap.readiness()).kind === "ready",
      { complete: (deadline) => bootstrap.promote(deadline) },
    );
    await wait(() => runtimeReady());
    await complete();
    return result;
  }

  function snapshotChange(before, patch) {
    const names = {},
      values = {};
    const conditions = Object.entries(before).map(([field, value], i) => {
      names["#c" + i] = field;
      values[":c" + i] = value;
      return "#c" + i + " = :c" + i;
    });
    if (before.sk === "CONTROL") {
      names["#deployment"] = "deployment";
      conditions.push("attribute_not_exists(#deployment)");
    }
    const changes = Object.entries(patch ?? {}).map(([field, value], i) => {
      names["#u" + i] = field;
      values[":u" + i] = value;
      return "#u" + i + " = :u" + i;
    });
    const input = {
      TableName: table,
      Key: marshall({ pk: before.pk, sk: before.sk }),
      ConditionExpression: conditions.join(" AND "),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: marshall(values),
    };
    return patch
      ? { Update: { ...input, UpdateExpression: "SET " + changes.join(", ") } }
      : { ConditionCheck: input };
  }
  async function previousState(previous, previousHash) {
    const control = await read("CONTROL"),
      receipt = await read("BOOTSTRAP#" + previous.operationId),
      introduction = await read();
    assert.equal(control?.coordinatorToken, previous.operationId);
    assert.equal(control.coordinatorEpoch, 1);
    assert.equal(control.runtimeEnvironment, "ecs");
    assert.equal(control.protocolVersion, 1);
    assert.equal(control.servingGeneration, 0);
    assert.deepEqual(control.servingMembers, {});
    assert(!control.deployment && control.coordinatorExpiresAt <= now());
    assert.equal(receipt?.operationId, previous.operationId);
    assert.equal(receipt.manifestSha256, previousHash);
    assert.equal(receipt.stage, "launched");
    uuid.parse(receipt.launchAttemptId);
    assert.equal(introduction?.operationId, previous.operationId);
    assert.equal(introduction.manifestSha256, previousHash);
    assert.equal(introduction.principalArn, previous.principalArn);
    assert.equal(introduction.stage, "routing_acknowledged");
    return { control, receipt, introduction };
  }
  async function completeIntroduction(previous, previousHash) {
    const [control, old, bootstrapReceipt, introduction, repairReceipt] =
      await Promise.all([
        read("CONTROL"),
        previous ? read("BOOTSTRAP#" + previous.operationId) : undefined,
        read("BOOTSTRAP#" + m.operationId),
        read(),
        read("REPAIR#" + m.operationId),
      ]);
    for (const [row, id, hash] of [
      [bootstrapReceipt, m.operationId, options.expectedSha256],
      [introduction, m.operationId, options.expectedSha256],
      ...(previous
        ? [
            [old, previous.operationId, previousHash],
            [repairReceipt, m.operationId, options.expectedSha256],
          ]
        : []),
    ]) {
      assert.equal(row?.operationId, id);
      assert.equal(row.manifestSha256, hash);
    }
    assert.equal(bootstrapReceipt.stage, "complete");
    assert.equal(introduction.principalArn, m.principalArn);
    const candidate = bootstrapReceipt.candidate;
    assert.equal(candidate?.kind, "ecs");
    assert.equal(candidate.protocolVersion, 1);
    assert.equal(candidate.candidateId, m.operationId);
    assert.equal(candidate.imageDigest, m.imageDigest);
    assert(sameEcsTaskArn(candidate.taskArn, candidate.taskArn));
    assert(
      candidate.taskArn.startsWith(
        `arn:aws:ecs:${m.region}:${m.accountId}:task/${m.cluster}/`,
      ),
    );
    assert.equal(control?.runtimeEnvironment, "ecs");
    assert.equal(control.protocolVersion, 1);
    assert.equal(control.coordinatorToken, m.operationId);
    assert.equal(control.coordinatorEpoch, 1);
    assert.equal(control.coordinatorExpiresAt, 0);
    assert.equal(control.servingGeneration, 1);
    assert.equal(control.deployment, undefined);
    assert.deepEqual(control.servingMembers, {
      [candidate.instanceId]: candidate,
    });
    const completed = introduction.stage === "complete";
    assert.equal(
      introduction.stage,
      completed ? "complete" : "routing_acknowledged",
    );
    if (previous) {
      assert.equal(old.stage, "superseded");
      assert.equal(old.supersededBy, m.operationId);
      for (const row of [introduction, repairReceipt]) {
        assert.equal(row.previousOperationId, previous.operationId);
        assert.equal(row.previousManifestSha256, previousHash);
      }
      assert.equal(repairReceipt.stage, completed ? "complete" : "initialized");
    } else {
      assert.equal(introduction.previousOperationId, undefined);
      assert.equal(introduction.previousManifestSha256, undefined);
      assert.equal(repairReceipt, undefined);
    }
    assert(await runtimeReady(), "Fresh serving confirmation required");
    if (!completed)
      await aws("dynamodb", "transact-write-items", {
        TransactItems: [
          snapshotChange(control),
          snapshotChange(bootstrapReceipt),
          snapshotChange(introduction, { stage: "complete" }),
          ...(previous
            ? [
                snapshotChange(old),
                snapshotChange(repairReceipt, { stage: "complete" }),
              ]
            : [
                {
                  ConditionCheck: {
                    TableName: table,
                    Key: marshall({ pk: "ENV", sk: "REPAIR#" + m.operationId }),
                    ConditionExpression: "attribute_not_exists(pk)",
                  },
                },
              ]),
        ],
      });
    return { kind: "complete", generation: 1 };
  }
  async function repair(previousInput, previousHash) {
    const previous = parseManifest(previousInput, previousHash);
    for (const field of [
      "environment",
      "accountId",
      "region",
      "tablePrefix",
      "bucket",
      "cluster",
      "service",
      "containerName",
      "containerPort",
      "runtimeMode",
      "listenerArn",
      "targetGroupA",
      "targetGroupB",
    ])
      assert.deepEqual(m[field], previous[field]);
    assert.notEqual(m.operationId, previous.operationId);
    assert.notEqual(m.sourceCommit, previous.sourceCommit);
    assert.notEqual(m.imageDigest, previous.imageDigest);
    assert.equal(m.legacyTaskDefinition, previous.taskDefinition);
    const actor = await aws("sts", "get-caller-identity", {});
    assert.equal(actor.Account, m.accountId);
    assert.equal(actor.Arn, m.principalArn);
    const repairKey = "REPAIR#" + m.operationId;
    if (await read(repairKey))
      return completeIntroduction(previous, previousHash);
    const prior = await previousState(previous, previousHash);
    assert.equal(await count(table), 3, "Foreign runtime or ownership remains");
    await workSettled();
    const current = await service();
    assert.equal(current.taskDefinition, m.legacyTaskDefinition);
    assert.equal(current.desiredCount, 1);
    await assertCandidateDefinition();
    const traffic = await listener();
    assert.deepEqual(
      canonical(traffic.DefaultActions),
      canonical(action(routing, false)),
    );
    await require("./bootstrap-sandbox.cjs").assertTargetGroups(
      m,
      aws,
      traffic,
    );
    assert.equal((await targets(m.targetGroupB)).length, 0);
    await assertRepairTargets();
    stopBudget();
    const receipt = {
      pk: "ENV",
      sk: repairKey,
      operationId: m.operationId,
      manifestSha256: options.expectedSha256,
      previousOperationId: previous.operationId,
      previousManifestSha256: previousHash,
      stage: "reserved",
    };
    const guards = Object.values(prior).map((row) => snapshotChange(row));
    await aws("dynamodb", "transact-write-items", {
      TransactItems: [
        ...guards,
        {
          Put: {
            TableName: table,
            Item: marshall(receipt),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    stopBudget();
    await stage("reserved", "stop_submitted", repairKey);
    await assertRepairTargets();
    stopBudget();
    const stopped = await aws("ecs", "update-service", {
      cluster: m.cluster,
      service: m.service,
      desiredCount: 0,
    });
    assert.equal(stopped.service.serviceName, m.service);
    assert.equal(stopped.service.desiredCount, 0);
    await stage("stop_submitted", "stop_acknowledged", repairKey);
    await waitForStoppedService();
    await workSettled();

    assert.deepEqual(
      canonical((await listener()).DefaultActions),
      canonical(action(routing, false)),
    );
    assert.equal(await count(table), 4, "Foreign runtime or ownership remains");
    const settled = await previousState(previous, previousHash),
      repairReceipt = await read(repairKey);
    assert.equal(repairReceipt.stage, "stop_acknowledged");
    assert(
      now() >= Date.parse(m.maintenance.confirmedAt) / 1000 &&
        now() - Date.parse(m.maintenance.confirmedAt) / 1000 <= 900,
      "Maintenance proof expired",
    );
    await aws("dynamodb", "transact-write-items", {
      TransactItems: [
        snapshotChange(settled.control, {
          coordinatorToken: m.operationId,
          coordinatorExpiresAt: now() + 1800,
        }),
        snapshotChange(settled.receipt, {
          stage: "superseded",
          supersededBy: m.operationId,
        }),
        snapshotChange(settled.introduction, {
          operationId: m.operationId,
          manifestSha256: options.expectedSha256,
          principalArn: m.principalArn,
          previousOperationId: previous.operationId,
          previousManifestSha256: previousHash,
        }),
        snapshotChange(repairReceipt, { stage: "initialized" }),
        {
          Put: {
            TableName: table,
            Item: marshall({
              pk: "ENV",
              sk: "BOOTSTRAP#" + m.operationId,
              operationId: m.operationId,
              manifestSha256: options.expectedSha256,
              stage: "initialized",
            }),
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    });
    return finish(() => completeIntroduction(previous, previousHash));
  }
  return { activate, repair };
}
async function runCli(phase, env = process.env) {
  try {
    const binding = bindJob(env);
    if (phase === "bind") {
      appendFileSync(
        env.GITHUB_OUTPUT,
        "session_name=" + binding.sessionName + "\n",
      );
      if (binding.manifest)
        writeFileSync(
          "bootstrap-manifest.json",
          JSON.stringify(binding.manifest),
          { mode: 0o600 },
        );
      return 0;
    }
    assert.equal(phase, env.BOOTSTRAP_PHASE);
    let result;
    if (phase === "prepare") result = await prepare(env);
    else {
      const introduction = createIntroduction({
        manifest: JSON.parse(readFileSync("bootstrap-manifest.json", "utf8")),
        expectedSha256: binding.manifestSha256,
      });
      result =
        phase === "repair"
          ? await introduction.repair(
              binding.previousManifest,
              binding.previousManifestSha256,
            )
          : await introduction.activate();
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch {
    console.error(
      JSON.stringify({
        kind: "introduction_refused",
        action: "preserve_state_and_reconcile",
      }),
    );
    return 1;
  }
}
module.exports = { bindJob, prepare, createIntroduction, runCli };
if (require.main === module)
  runCli(process.argv[2]).then((code) => {
    process.exitCode = code;
  });
