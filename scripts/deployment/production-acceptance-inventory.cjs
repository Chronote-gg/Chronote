"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { candidateSlot } = require("./production-candidate.cjs");
const { createRuntimeProof } = require("./runtime-proof.cjs");
function refuse() {
  throw Error("acceptance_writer_prerequisite");
}
function assertRetired(row, control, now) {
  const request = row.retirementRequest;
  if (
    row.role !== "retired" ||
    !request ||
    !same(request.identity, row.identity) ||
    request.authorizedGeneration !== row.authorizedGeneration ||
    !same(row.retirementAcknowledgment?.request, request) ||
    row.retirementAcknowledgment.retiredAt > now ||
    request.coordinatorEpoch > control.coordinatorEpoch
  )
    refuse();
}
function assertWriterTask(m, row, task) {
  const slot = ["bootstrap", "replacement", "handoff"]
    .map((name) => candidateSlot(m, name))
    .find((slot) => slot.candidateId === row.identity.candidateId);
  const container = task.containers?.find(
    (value) => value.name === m.runtime.container,
  );
  if (
    !slot ||
    task.taskDefinitionArn !== slot.definition ||
    row.identity.imageDigest !== slot.digest ||
    container?.imageDigest !== slot.digest ||
    container.networkInterfaces?.length !== 1 ||
    !["RUNNING", "STOPPED"].includes(task.lastStatus) ||
    !["RUNNING", "STOPPED"].includes(task.desiredStatus)
  )
    refuse();
  if (
    task.overrides?.some(
      (value) =>
        value.environmentNames?.length ||
        value.environmentFiles?.length ||
        value.commandLength,
    )
  )
    refuse();
  return container.networkInterfaces[0].privateIpv4Address;
}
function assertServices(m, inventory) {
  const [service] = inventory.services;
  if (
    inventory.services.length !== 1 ||
    service.serviceArn !== m.runtime.serviceArn ||
    service.desiredCount !== 1 ||
    service.pendingCount !== 0 ||
    service.runningCount !==
      inventory.tasks.filter((task) => task.lastStatus === "RUNNING").length
  )
    refuse();
}
function assertCurrentMembership(m, fixtureAuthority, runtimes, d) {
  if (
    runtimes.length !==
      (fixtureAuthority.priorEpoch === m.handoff.priorEpoch ? 2 : 3) ||
    !runtimes.some((row) => same(row.identity, fixtureAuthority.priorMember)) ||
    !runtimes.some((row) => same(row.identity, d.candidate))
  )
    refuse();
}
function assertCurrentControl({ m, control, fixtureAuthority, runtimes }) {
  const d = control.deployment;
  if (
    !d ||
    d.phase !== "complete" ||
    control.compatibleReplacement ||
    control.coordinatorToken !== m.handoff.runToken ||
    control.coordinatorEpoch !== fixtureAuthority.priorEpoch + 1 ||
    d.originalGeneration !== fixtureAuthority.priorGeneration ||
    control.servingGeneration !== d.originalGeneration + 1 ||
    !same(d.outgoing, fixtureAuthority.priorMember) ||
    !same(d.originalMembers, [fixtureAuthority.priorMember]) ||
    Object.keys(control.servingMembers).length !== 1 ||
    !same(Object.values(control.servingMembers)[0], d.candidate) ||
    d.candidate?.candidateId !== m.handoff.candidateId ||
    d.taskDefinition !== m.runtime.continuationDefinition
  )
    refuse();
  assertCurrentMembership(m, fixtureAuthority, runtimes, d);
  return d;
}
function assertCurrentRuntime(row, state, proof) {
  const { m, control, now } = state;
  if (
    row.identity.kind !== "ecs" ||
    row.expiresAt !== undefined ||
    !row.workCounts ||
    Object.values(row.workCounts).some((count) => count !== 0)
  )
    refuse();
  const serving = same(
    control.servingMembers[row.identity.instanceId],
    row.identity,
  );
  if (serving) {
    if (
      row.role !== "serving" ||
      row.authorizedGeneration !== control.servingGeneration ||
      row.retirementRequest ||
      row.retirementAcknowledgment ||
      !proof.ready(row, control, row.identity, m.runtime.mode)
    )
      refuse();
  } else assertRetired(row, control, now);
  return serving;
}
function assertTargets(state, writers) {
  const { m, inventory, control } = state;
  const route = control.deployment.routing;
  if (
    !route ||
    route.state !== "candidate" ||
    route.listenerArn !== m.resources.listenerArn ||
    route.sourceGroup !== m.resources.targetGroupA ||
    route.candidateGroup !== m.resources.targetGroupB
  )
    refuse();
  for (const target of inventory.targets) {
    const matches = writers.filter((writer) => writer.ip === target.targetId);
    if (
      matches.length !== 1 ||
      !["healthy", "draining", "initial", "unused"].includes(target.state)
    )
      refuse();
    if (
      matches[0].serving &&
      (target.targetGroupArn !== route.candidateGroup ||
        target.state !== "healthy")
    )
      refuse();
  }
  const serving = writers.find((writer) => writer.serving);
  if (
    inventory.targets.filter(
      (target) =>
        target.targetId === serving.ip &&
        target.targetGroupArn === route.candidateGroup &&
        target.state === "healthy",
    ).length !== 1
  )
    refuse();
}
function assertOtherTasks(m, inventory, writers) {
  for (const task of inventory.tasks) {
    if (writers.some((writer) => writer.identity.taskArn === task.taskArn))
      continue;
    if (
      !m.runtime.legacyTaskArns.includes(task.taskArn) ||
      task.taskDefinitionArn !== m.runtime.legacyDefinition ||
      task.lastStatus !== "STOPPED" ||
      task.desiredStatus !== "STOPPED" ||
      task.protectionEnabled
    )
      refuse();
  }
}
/** Pure classification only. The authenticated producer supplies every observation. */
function assertAcceptanceWriters(state) {
  const { m, inventory, now } = state;
  const types = require("../../dist/types/deploymentControl.js");
  types.controlRecordSchema.parse(state.control);
  state.runtimes.forEach((row) => types.runtimeRecordSchema.parse(row));
  assertCurrentControl(state);
  if (
    inventory.blockers.length ||
    inventory.launchers.length ||
    new Set(state.runtimes.map((row) => row.identity.taskArn)).size !==
      state.runtimes.length
  )
    refuse();
  assertServices(m, inventory);
  const proof = createRuntimeProof({
    config: { cluster: m.runtime.clusterArn },
    types,
    now: () => now,
    diagnostic: {},
  });
  const writers = [];
  for (const row of state.runtimes) {
    const tasks = inventory.tasks.filter(
      (task) => task.taskArn === row.identity.taskArn,
    );
    if (tasks.length !== 1) refuse();
    const task = tasks[0],
      serving = assertCurrentRuntime(row, state, proof);
    if (task.group !== `service:${m.runtime.serviceArn.split("/").at(-1)}`)
      refuse();
    const ip = assertWriterTask(m, row, task);
    if (
      serving
        ? task.lastStatus !== "RUNNING" ||
          task.desiredStatus !== "RUNNING" ||
          !task.protectionEnabled ||
          !(Date.parse(task.protectionExpiresAt) / 1000 > now + 120)
        : task.protectionEnabled
    )
      refuse();
    writers.push({
      identity: row.identity,
      sourceCommit: m.identity.sourceCommit,
      serving,
      ip,
    });
  }
  assertOtherTasks(m, inventory, writers);
  assertTargets(state, writers);
  return writers;
}
async function readRuntimeInventory(m, readers) {
  const types = require("../../dist/types/deploymentControl.js");
  const rows = [],
    seen = new Set(),
    tokens = new Set();
  let key;
  do {
    const page = await readers.aws("dynamodb", "query", {
      TableName: m.resources.tables.deploymentControl,
      KeyConditionExpression: "pk = :env AND begins_with(sk, :runtime)",
      ExpressionAttributeValues: marshall({
        ":env": "ENV",
        ":runtime": "RUNTIME#",
      }),
      ConsistentRead: true,
      ...(key ? { ExclusiveStartKey: key } : {}),
    });
    if (!Array.isArray(page.Items)) refuse();
    for (const item of page.Items) {
      const row = types.runtimeRecordSchema.parse(unmarshall(item));
      if (seen.has(row.sk)) refuse();
      seen.add(row.sk);
      rows.push(row);
    }
    key = page.LastEvaluatedKey;
    if (key) {
      const token = JSON.stringify(key);
      if (!Object.keys(key).length || tokens.has(token) || tokens.size >= 1000)
        refuse();
      tokens.add(token);
    }
  } while (key);
  return rows;
}
module.exports = { assertAcceptanceWriters, readRuntimeInventory };
