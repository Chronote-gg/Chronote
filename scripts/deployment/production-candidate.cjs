"use strict";
const { unmarshall, marshall } = require("@aws-sdk/util-dynamodb");
const { canonicalHash } = require("./production-manifest.cjs");
const { definitionMetadata } = require("./production-inventory-adapter.cjs");
const { createRuntimeProof } = require("./runtime-proof.cjs");
function candidateSlot(m, slot) {
  if (slot === "bootstrap")
    return {
      candidateId: m.runtime.candidateId,
      definition: m.runtime.candidateDefinition,
      digest: m.runtime.candidateDigest,
      epoch: 1,
      token: m.handoff.priorRunToken,
    };
  if (slot === "replacement" && m.failedUnserved)
    return {
      candidateId: m.failedUnserved.candidateId,
      definition: m.failedUnserved.taskDefinition,
      digest: m.failedUnserved.imageDigest,
      epoch: m.failedUnserved.epoch,
      token: m.failedUnserved.runToken,
    };
  if (slot === "handoff")
    return {
      candidateId: m.handoff.candidateId,
      definition: m.runtime.continuationDefinition,
      digest: m.runtime.continuationDigest,
    };
  throw Error("candidate_slot_refused");
}
function assertEmptyControl(control) {
  if (
    control.servingGeneration !== 0 ||
    Object.keys(control.servingMembers).length ||
    control.deployment ||
    control.compatibleReplacement
  )
    throw Error("candidate_unserved_unconfirmed");
}
function assertUnservedRuntime(runtime, slot) {
  if (
    runtime.identity.kind !== "ecs" ||
    runtime.identity.candidateId !== slot.candidateId ||
    runtime.identity.imageDigest !== slot.digest ||
    runtime.authorizedGeneration !== 0 ||
    runtime.role !== "candidate" ||
    runtime.retirementRequest ||
    runtime.retirementAcknowledgment ||
    !runtime.workCounts ||
    Object.values(runtime.workCounts).some((n) => n !== 0)
  )
    throw Error("candidate_unserved_unconfirmed");
}
function assertCandidateTask(m, s, svc, running) {
  if (
    svc.serviceArn !== m.runtime.serviceArn ||
    svc.desiredCount !== 1 ||
    svc.runningCount !== 1 ||
    svc.pendingCount !== 0 ||
    svc.taskDefinition !== s.definition ||
    running.length !== 1
  )
    throw Error("candidate_waiting");
  const task = running[0],
    container = task.containers?.find((c) => c.name === m.runtime.container);
  if (
    task.taskDefinitionArn !== s.definition ||
    task.lastStatus !== "RUNNING" ||
    container?.imageDigest !== s.digest
  )
    throw Error("candidate_waiting");
  return { task, container };
}
function definitionContainer(m, s, d) {
  const c = d.containerDefinitions.find((v) => v.name === m.runtime.container);
  if (
    d.family !== m.runtime.family ||
    d.cpu !== "512" ||
    d.memory !== "1024" ||
    d.status !== "ACTIVE" ||
    d.taskRoleArn !== m.resources.taskRoleArn ||
    d.executionRoleArn !== m.resources.executionRoleArn ||
    canonicalHash(definitionMetadata(d)) !== m.runtime.configurationHash
  )
    throw Error("candidate_configuration_prerequisite");
  if (
    c?.stopTimeout !== 120 ||
    c.environment.filter((v) => v.name === "DEPLOYMENT_CANDIDATE_ID").length !==
      1 ||
    c.environment.find((v) => v.name === "DEPLOYMENT_CANDIDATE_ID").value !==
      s.candidateId ||
    require("./coordinator-definition.cjs").runtimeMode(c) !== m.runtime.mode
  )
    throw Error("candidate_configuration_prerequisite");
  return c;
}
function sourceRepository(m, s, c) {
  const match = c.image.match(
    /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([a-z0-9/_-]+)@(sha256:[a-f0-9]{64})$/,
  );
  if (
    !match ||
    match[1] !== m.identity.accountId ||
    match[2] !== m.identity.region ||
    match[4] !== s.digest ||
    match[3].includes("sandbox")
  )
    throw Error("candidate_source_prerequisite");
  return match[3];
}
function createCandidateInspection({ binding, aws, read, definition, now }) {
  const m = binding.manifest,
    types = require("../../dist/types/deploymentControl.js");
  const proof = createRuntimeProof({
    aws,
    config: { cluster: m.runtime.clusterArn },
    types,
    now,
    diagnostic: {},
  });
  async function service() {
    const r = await aws("ecs", "describe-services", {
      cluster: m.runtime.clusterArn,
      services: [m.runtime.serviceArn],
    });
    if (r.failures?.length || r.services?.length !== 1)
      throw Error("service_unconfirmed");
    return r.services[0];
  }
  async function tasks() {
    const arns = [];
    let nextToken;
    const tokens = new Set();
    do {
      const r = await aws("ecs", "list-tasks", {
        cluster: m.runtime.clusterArn,
        serviceName: m.runtime.serviceArn,
        desiredStatus: "RUNNING",
        ...(nextToken ? { nextToken } : {}),
      });
      arns.push(...r.taskArns);
      nextToken = r.nextToken;
      if (nextToken && tokens.has(nextToken))
        throw Error("task_inventory_incomplete");
      tokens.add(nextToken);
    } while (nextToken);
    if (!arns.length) return [];
    const r = await aws("ecs", "describe-tasks", {
      cluster: m.runtime.clusterArn,
      tasks: arns,
    });
    if (r.failures?.length || r.tasks.length !== arns.length)
      throw Error("task_inventory_incomplete");
    return r.tasks;
  }
  async function definitions() {
    for (const slot of ["bootstrap", "replacement", "handoff"]) {
      const s = candidateSlot(m, slot),
        d = await definition(s.definition),
        c = definitionContainer(m, s, d);
      const repositoryName = sourceRepository(m, s, c);
      const image = await aws("ecr", "describe-images", {
        repositoryName,
        imageIds: [{ imageTag: m.identity.sourceCommit }],
      });
      if (
        image.imageDetails?.length !== 1 ||
        image.imageDetails[0].imageDigest !== s.digest
      )
        throw Error("candidate_source_prerequisite");
    }
  }
  async function inspect(slot, { ready = false } = {}) {
    const s = candidateSlot(m, slot),
      svc = await service(),
      running = await tasks();
    const { task, container } = assertCandidateTask(m, s, svc, running);
    const runtime = await candidateRuntime(task);
    const control = types.controlRecordSchema.parse(
      await read({ pk: "ENV", sk: "CONTROL" }),
    );
    assertUnservedRuntime(runtime, s);
    assertEmptyControl(control);
    if (ready) await assertReady(s, runtime, control, container);
    return { runtime, control, task, service: svc };
  }
  async function candidateRuntime(task) {
    const result = await aws("dynamodb", "query", {
      TableName: m.resources.tables.deploymentControl,
      KeyConditionExpression: "pk = :env AND begins_with(sk, :runtime)",
      ExpressionAttributeValues: marshall({
        ":env": "ENV",
        ":runtime": "RUNTIME#",
      }),
      ConsistentRead: true,
    });
    if (result.LastEvaluatedKey) throw Error("runtime_inventory_incomplete");
    const rows = result.Items.map(unmarshall).filter(
      (r) => r.identity?.taskArn === task.taskArn,
    );
    if (rows.length !== 1) throw Error("candidate_waiting");
    return types.runtimeRecordSchema.parse(
      await read({ pk: "ENV", sk: rows[0].sk }),
    );
  }
  async function assertReady(s, runtime, control, container) {
    if (
      control.coordinatorToken !== s.token ||
      control.coordinatorEpoch !== s.epoch ||
      !proof.ready(runtime, control, runtime.identity, m.runtime.mode)
    )
      throw Error("candidate_waiting");
    await proof.protectedTask(runtime.identity);
    const target = await aws("elbv2", "describe-target-health", {
      TargetGroupArn: m.resources.targetGroupA,
    });
    if (
      container.networkInterfaces?.length !== 1 ||
      target.TargetHealthDescriptions?.length !== 1 ||
      target.TargetHealthDescriptions[0].Target.Id !==
        container.networkInterfaces[0].privateIpv4Address ||
      target.TargetHealthDescriptions[0].TargetHealth.State !== "healthy"
    )
      throw Error("candidate_waiting");
  }
  return { definitions, inspect, service, tasks };
}
module.exports = {
  createCandidateInspection,
  candidateSlot,
  assertEmptyControl,
  assertUnservedRuntime,
};
