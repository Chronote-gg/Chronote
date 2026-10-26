/** @jest-environment node */
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { GetItemCommandInput } from "@aws-sdk/client-dynamodb";
import type { GetTaskProtectionCommandInput } from "@aws-sdk/client-ecs";
import { routingFixture } from "../deployment/fixtures/routingFixture";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";
import {
  canonical,
  action,
  createRouting,
} from "../../scripts/deployment/routing.cjs";

test("candidate registration stays at zero weight until exact promotion, then rollback preserves candidate work", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  expect(f.svc.loadBalancers[0].targetGroupArn).toBe("group-b");
  expect(canonical(f.traffic.actions)).toEqual(
    canonical(action(f.routing, false)),
  );
  expect(f.state.ctl.servingMembers.old).toBeDefined();
  await f.coordinator.promote();
  expect(f.state.ctl.deployment?.routing?.state).toBe("candidate");
  expect(canonical(f.traffic.actions)).toEqual(
    canonical(action(f.routing, true)),
  );
  f.state.rows.new.workCounts!.recording = 1;
  f.refreshProofs();
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "rolled_back",
    candidatePreserved: true,
  });
  expect(canonical(f.traffic.actions)).toEqual(
    canonical(action(f.routing, false)),
  );
  expect(f.state.rows.new.workCounts!.recording).toBe(1);
  expect(f.state.rows.new.retirementRequest).toBeUndefined();
});
test.each([true, false])(
  "unknown routing apply=%s stays fenced despite exact readback",
  async (applied) => {
    const f = routingFixture();
    await f.coordinator.prepare();
    f.traffic.unknown = true;
    f.traffic.failBeforeApply = !applied;
    await expect(f.coordinator.promote()).rejects.toThrow();
    expect(f.state.ctl.deployment?.routing?.state).toBe("forward_submitted");
    f.traffic.unknown = false;
    expect(await f.coordinator.reconcile()).toMatchObject({
      kind: "recovery_required",
      reason: "routing_request_settlement_unknown",
      observedRouting: applied ? "candidate" : "source",
    });
    await expect(f.coordinator.promote()).rejects.toThrow(
      "settlement is unknown",
    );
    await expect(f.coordinator.retire()).rejects.toThrow();
    expect(
      f.calls.filter((call) => call.operation === "modify-listener"),
    ).toHaveLength(1);
    expect(f.state.rows.old.retirementRequest).toBeUndefined();
  },
);
test.each(["foreign", "draining", "same", "missing", "rule"])(
  "prepare rejects %s routing before deployment mutation",
  async (kind) => {
    const f = routingFixture();
    if (kind === "foreign") f.traffic.candidateTargets = [f.target(true)];
    if (kind === "draining")
      f.traffic.candidateTargets = [
        { ...f.target(true), TargetHealth: { State: "draining" } },
      ];
    if (kind === "same") f.options.env.DEPLOYMENT_TARGET_GROUP_B = "group-a";
    if (kind === "missing") f.options.env.DEPLOYMENT_LISTENER_ARN = "";
    if (kind === "rule") f.traffic.extraRules = true;
    await expect(createCoordinator(f.options).prepare()).rejects.toThrow();
    expect(f.calls.some((call) => call.operation === "update-service")).toBe(
      false,
    );
  },
);
test("stale listener weights and foreign candidate targets refuse promotion", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  f.traffic.actions = action(f.routing, true);
  await expect(f.coordinator.promote()).rejects.toThrow();
  expect(f.state.ctl.servingMembers.old).toBeDefined();
  f.traffic.actions = action(f.routing, false);
  f.traffic.candidateTargets.push({
    ...f.target(true),
    Target: { Id: "10.0.0.99", Port: 3001 },
  });
  await expect(f.coordinator.promote()).rejects.toThrow();
  expect(f.state.ctl.servingMembers.old).toBeDefined();
});

test("revision mismatch and changed workflow inputs refuse promotion", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  f.traffic.revisionMismatch = true;
  await expect(f.coordinator.promote()).rejects.toThrow("revision binding");
  expect(f.state.ctl.servingMembers.old).toBeDefined();
  f.traffic.revisionMismatch = false;
  f.options.env.DEPLOYMENT_LISTENER_ARN = "other-listener";
  await expect(createCoordinator(f.options).promote()).rejects.toThrow(
    "inputs changed",
  );
  expect(f.calls.some((call) => call.operation === "modify-listener")).toBe(
    false,
  );
});

test("unknown rollback cannot replay routing or retire either protected owner", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.refreshProofs();
  f.traffic.unknown = true;
  await expect(f.coordinator.reconcile()).rejects.toThrow(
    "Coordinator AWS operation failed",
  );
  expect(f.state.ctl.deployment?.routing?.state).toBe("rollback_submitted");
  f.traffic.unknown = false;
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "recovery_required",
    reason: "routing_request_settlement_unknown",
    observedRouting: "source",
  });
  expect(f.state.ctl.deployment?.routing?.state).toBe("rollback_submitted");
  await expect(f.coordinator.retire()).rejects.toThrow();
  expect(
    f.calls.filter((call) => call.operation === "modify-listener"),
  ).toHaveLength(2);
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(f.state.rows.new.retirementRequest).toBeUndefined();
});

test("completed deployment cannot reuse a slot until old target registration clears", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.state.retirementAcknowledged = true;
  expect(await f.coordinator.retire()).toEqual({ kind: "complete" });
  const routing = createRouting({
    aws: f.aws,
    config: { cluster: "cluster", service: "service" },
    env: f.options.env,
    failure: (_category: string, message: string) => new Error(message),
  });
  await expect(routing.prepare(f.svc, f.candidateIdentity)).rejects.toThrow(
    "Spare target group",
  );
  f.traffic.sourceTargets = [];
  expect(await routing.prepare(f.svc, f.candidateIdentity)).toMatchObject({
    sourceGroup: "group-b",
    candidateGroup: "group-a",
    sourceRevision: "revision-new",
    state: "source",
  });
});

test("rollback restores the healthy old destination when the protected candidate target fails", async () => {
  const f = routingFixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.refreshProofs();
  f.traffic.candidateTargets[0].TargetHealth.State = "unhealthy";
  f.state.rows.new.readiness.dependenciesReady = false;
  f.state.rows.new.workCounts!.recording = 1;
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "rolled_back",
    candidatePreserved: true,
    recoveryRequired: true,
  });
  expect(f.state.ctl.servingMembers).toEqual({ old: f.oldIdentity });
  expect(canonical(f.traffic.actions)).toEqual(
    canonical(action(f.routing, false)),
  );
  expect(f.state.rows.new.workCounts!.recording).toBe(1);
  expect(f.state.rows.new.retirementRequest).toBeUndefined();
});

async function interruptedRollback() {
  const f = routingFixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.refreshProofs();
  const original = f.aws.getMockImplementation()!;
  let loseRead = true;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (
      loseRead &&
      operation === "get-item" &&
      f.state.ctl.servingGeneration === 3 &&
      unmarshall((input as GetItemCommandInput).Key!).sk === "CONTROL"
    ) {
      loseRead = false;
      throw new Error("Runner lost control read after membership commit");
    }
    return original(service, operation, input);
  });
  await expect(f.coordinator.reconcile()).rejects.toThrow();
  expect(f.state.ctl.servingGeneration).toBe(3);
  expect(f.state.ctl.deployment).toMatchObject({
    phase: "rollback_promoting",
    routing: { state: "candidate" },
  });
  expect(
    f.calls.filter((call) => call.operation === "modify-listener"),
  ).toHaveLength(1);
  f.aws.mockImplementation(original);
  return f;
}

test.each([
  "old_readiness",
  "old_protection",
  "old_target",
  "old_revision",
  "candidate_protection",
  "candidate_identity",
  "candidate_target",
  "candidate_revision",
])(
  "resumed rollback refuses %s loss before reverse dispatch",
  async (failure) => {
    const f = await interruptedRollback();
    const original = f.aws.getMockImplementation()!;
    f.aws.mockImplementation(async (service, operation, input) => {
      if (
        operation === "get-task-protection" &&
        (input as GetTaskProtectionCommandInput).tasks?.includes(
          failure === "old_protection"
            ? "arn:aws:ecs:us-east-1:123456789012:task/fixture/old"
            : failure === "candidate_protection"
              ? "arn:aws:ecs:us-east-1:123456789012:task/fixture/new"
              : "none",
        )
      )
        return { protectedTasks: [] };
      if (
        operation === "describe-service-revisions" &&
        failure === "old_revision"
      )
        return { serviceRevisions: [] };
      return original(service, operation, input);
    });
    if (failure === "old_readiness")
      f.state.rows.old.readiness.dependenciesReady = false;
    if (failure === "old_target")
      f.traffic.sourceTargets[0].TargetHealth.State = "unhealthy";
    if (failure === "candidate_target")
      f.traffic.candidateTargets[0].Target.Id = "10.0.0.99";
    if (failure === "candidate_identity")
      f.state.rows.new.identity = {
        ...f.candidateIdentity,
        imageDigest: `sha256:${"c".repeat(64)}`,
      };
    if (failure === "candidate_revision") f.traffic.revisionMismatch = true;
    const result = await f.coordinator
      .reconcile()
      .catch(() => ({ kind: "refused" }));
    expect(result.kind).not.toBe("rolled_back");
    expect(f.state.ctl.deployment?.routing?.state).toBe("candidate");
    expect(canonical(f.traffic.actions)).toEqual(
      canonical(action(f.routing, true)),
    );
    expect(
      f.calls.filter((call) => call.operation === "modify-listener"),
    ).toHaveLength(1);
    expect(f.state.rows.old.retirementRequest).toBeUndefined();
    expect(f.state.rows.new.retirementRequest).toBeUndefined();
  },
);

test("resumed rollback freshly validates the destination and preserves unhealthy candidate work", async () => {
  const f = await interruptedRollback();
  f.traffic.candidateTargets[0].TargetHealth.State = "unhealthy";
  f.state.rows.new.readiness.dependenciesReady = false;
  f.state.rows.new.workCounts!.recording = 1;
  const previousCalls = f.calls.length;
  expect(await f.coordinator.reconcile()).toMatchObject({
    kind: "rolled_back",
    candidatePreserved: true,
  });
  const resumed = f.calls.slice(previousCalls);
  expect(
    resumed.filter((call) => call.operation === "get-task-protection"),
  ).toHaveLength(2);
  expect(
    resumed.filter((call) => call.operation === "describe-target-health"),
  ).toHaveLength(2);
  expect(
    resumed.findIndex((call) => call.operation === "modify-listener"),
  ).toBeGreaterThan(
    resumed.findIndex(
      (call) => call.operation === "describe-service-revisions",
    ),
  );
  expect(f.state.rows.new.workCounts!.recording).toBe(1);
  expect(f.state.rows.new.retirementRequest).toBeUndefined();
});

test.each(["source", "candidate"])(
  "forward promotion still requires the %s target healthy",
  async (side) => {
    const f = routingFixture();
    await f.coordinator.prepare();
    const targets =
      side === "source" ? f.traffic.sourceTargets : f.traffic.candidateTargets;
    targets[0].TargetHealth.State = "unhealthy";
    await expect(f.coordinator.promote()).rejects.toThrow("not healthy");
    expect(f.state.ctl.servingMembers).toEqual({ old: f.oldIdentity });
    expect(f.calls.some((call) => call.operation === "modify-listener")).toBe(
      false,
    );
  },
);
