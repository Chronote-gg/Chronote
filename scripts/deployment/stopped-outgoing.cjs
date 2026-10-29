"use strict";
const { isDeepStrictEqual } = require("node:util");
const { sameEcsTaskArn } = require("../../src/utils/ecsTaskArn.js");
const {
  CoordinatorFailure,
  listServiceTaskArns,
} = require("./coordinator-aws.cjs");
// A live runtime heartbeats every 10 seconds, and ECS task protection lasts at
// most 10 minutes. A row silent for longer cannot belong to a protected task.
const STOPPED_HEARTBEAT_SECONDS = 600;
const refuse = (message) => {
  throw new CoordinatorFailure("continuation_refused", message);
};
function assertConverged(svc, d) {
  if (
    svc.taskDefinition !== d.taskDefinition ||
    svc.pendingCount !== 0 ||
    svc.runningCount !== 1 ||
    svc.deployments?.length !== 1 ||
    svc.deployments[0].rolloutState !== "COMPLETED"
  )
    refuse("ECS service must be converged on the candidate with no rollout");
}
function assertUnacknowledgedRetirement(row, d, same) {
  const request = row.retirementRequest;
  if (
    !["serving", "draining", "releasing"].includes(row.role) ||
    row.retirementAcknowledgment ||
    row.retirementContinuation ||
    row.authorizedGeneration !== d.originalGeneration ||
    !request ||
    !same(request.identity, d.outgoing) ||
    request.coordinatorToken !== d.runToken ||
    request.authorizedGeneration !== d.originalGeneration
  )
    refuse(
      "Outgoing runtime must hold this deployment's unacknowledged retirement request",
    );
}
/**
 * Completes a `retiring` deployment whose outgoing task ECS already stopped
 * (for example after its runtime gave up native protection and failed health
 * checks). The runtime can never acknowledge retirement, so `retire` times
 * out and every later `prepare` would refuse the environment.
 */
function createStoppedOutgoingContinuation({
  aws,
  config,
  builders,
  tables,
  now,
  production,
  control,
  service,
  runtime,
  ready,
  protectedTask,
  routing,
  promotionObserved,
  types,
  warn = (message) => console.log(message),
}) {
  const same = types.sameRuntimeIdentity;
  function assertAuthority(ctl) {
    const d = ctl.deployment;
    if (production) refuse("Production introduction continuation is separate");
    if (d?.phase !== "retiring") refuse("Retiring deployment required");
    const sameRun =
      ctl.coordinatorToken === config.runToken &&
      d.runToken === config.runToken;
    if (ctl.coordinatorExpiresAt > now() && !sameRun)
      refuse("Previous coordinator lease is still live");
    if (
      !["cluster", "service", "family", "tablePrefix"].every(
        (field) => d[field] === config[field],
      )
    )
      refuse("Deployment environment mismatch");
    routing.assertInputs(d.routing);
    return d;
  }
  async function assertCandidateServing(ctl, d) {
    const retained = d.originalMembers.filter(
      (member) => member.instanceId !== d.outgoing.instanceId,
    );
    if (
      !d.candidate ||
      !promotionObserved(ctl, d.candidate, d.originalGeneration + 1, retained)
    )
      refuse("Exact promoted candidate membership required");
    const active = await runtime(d.candidate);
    if (
      active.role !== "serving" ||
      !ready(active, ctl, d.candidate, d.runtimeMode)
    )
      refuse("Promoted candidate must be serving and ready");
    await protectedTask(d.candidate);
    const svc = await service();
    assertConverged(svc, d);
    const running = await listServiceTaskArns(aws, config);
    if (
      running.length !== 1 ||
      !sameEcsTaskArn(running[0], d.candidate.taskArn)
    )
      refuse("Only the promoted candidate task may be running");
    if (d.routing) {
      if (d.routing.state !== "candidate")
        refuse("Acknowledged candidate routing required");
      await routing.assertAction(d.routing, true);
      await routing.serving(ctl, svc);
    }
  }
  /**
   * ECS keeps a stopped task describable for about an hour. After that it is
   * MISSING, which alone cannot distinguish a pruned task from a bad ARN. A
   * missing task therefore also needs the service's running list to exclude
   * it (checked by the caller) and a heartbeat silent for longer than any
   * native protection could last.
   */
  async function stoppedTask(d, row) {
    const result = await aws("ecs", "describe-tasks", {
      cluster: config.cluster,
      tasks: [d.outgoing.taskArn],
    });
    const task = result.tasks?.find((item) =>
      sameEcsTaskArn(item.taskArn, d.outgoing.taskArn),
    );
    if (task) {
      if (
        task.lastStatus !== "STOPPED" ||
        !Number.isFinite(Date.parse(task.stoppedAt)) ||
        task.taskDefinitionArn !== d.previousTaskDefinition
      )
        refuse("Outgoing ECS task must be STOPPED");
      return {
        taskStatus: "stopped",
        stoppedAt: new Date(Date.parse(task.stoppedAt)).toISOString(),
        ...(task.stoppedReason
          ? { stoppedReason: task.stoppedReason.slice(0, 1024) }
          : {}),
      };
    }
    const missing = result.failures ?? [];
    if (
      result.tasks?.length ||
      missing.length !== 1 ||
      missing[0].reason !== "MISSING" ||
      !sameEcsTaskArn(missing[0].arn, d.outgoing.taskArn)
    )
      refuse("Outgoing ECS task state is unconfirmed");
    if (row.heartbeatAt + STOPPED_HEARTBEAT_SECONDS > now())
      refuse("Missing outgoing task still has a recent heartbeat");
    return { taskStatus: "missing" };
  }
  async function write(ctl, row, continuation) {
    try {
      await aws(
        "dynamodb",
        "transact-write-items",
        builders.buildStoppedOutgoingContinuation(
          { control: ctl, outgoing: row, continuation, now: now() },
          tables,
        ),
      );
    } catch (error) {
      const observed = await runtime(ctl.deployment.outgoing);
      if (!isDeepStrictEqual(observed.retirementContinuation, continuation))
        throw error;
    }
    const observed = await control();
    if (
      observed.deployment?.phase !== "complete" ||
      observed.deployment.runToken !== ctl.deployment.runToken
    )
      throw new CoordinatorFailure(
        "outcome_uncertain",
        "Continuation acknowledgment missing",
      );
    return observed;
  }
  async function continueStoppedOutgoing(ctl) {
    const d = assertAuthority(ctl);
    await assertCandidateServing(ctl, d);
    const row = await runtime(d.outgoing);
    assertUnacknowledgedRetirement(row, d, same);
    const continuation = {
      reason: "outgoing_task_stopped",
      ...(await stoppedTask(d, row)),
      ...(row.workCounts ? { lostWorkCounts: row.workCounts } : {}),
      continuedBy: config.runToken,
      continuedAt: now(),
    };
    const completed = await write(ctl, row, continuation);
    const lost = Object.entries(continuation.lostWorkCounts ?? {})
      .map(([kind, count]) => `${kind}=${count}`)
      .join(", ");
    warn(
      `::warning title=Outgoing task stopped before retirement::Completed deployment ${d.runToken} without a retirement acknowledgment. ECS had already stopped the outgoing task (${continuation.taskStatus}); work it still counted is lost: ${lost || "unknown"}. Leases were not modified.`,
    );
    return {
      control: completed,
      result: {
        kind: "continued",
        taskStatus: continuation.taskStatus,
        lostWorkCounts: continuation.lostWorkCounts,
      },
    };
  }
  return { continueStoppedOutgoing };
}
module.exports = {
  createStoppedOutgoingContinuation,
  STOPPED_HEARTBEAT_SECONDS,
};
