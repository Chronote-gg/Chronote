/** @jest-environment node */
import {
  createCoordinator,
  runCli,
} from "../../scripts/deployment/coordinator.cjs";
import {
  fixture,
  counts,
  env,
  candidateIdentity,
} from "../deployment/fixtures/coordinatorFixture";

const nextRun = { ...env, DEPLOYMENT_RUN_TOKEN: "run-3" };
const lostCounts = { ...counts(), finalization: 1 };
const writes = ["transact-write-items", "update-item", "update-service"];

/** Promoted, retirement requested, then the outgoing task died holding finalization. */
async function stranded() {
  const f = fixture();
  await f.coordinator.prepare();
  await f.coordinator.promote();
  f.state.rows.old.workCounts = { ...lostCounts };
  await expect(f.coordinator.retire()).rejects.toMatchObject({
    category: "retirement_incomplete",
  });
  f.state.rows.old.role = "draining";
  f.state.outgoingTask = "stopped";
  const warnings: string[] = [];
  const next = () =>
    createCoordinator({
      ...f.options,
      env: nextRun,
      warn: (message: string) => warnings.push(message),
    });
  // retire's final sleep already passed its lease; one more sleep makes that explicit.
  const expire = () => f.options.sleep();
  f.calls.length = 0;
  return { ...f, warnings, next, expire };
}
const wrote = (f: { calls: Array<{ operation: string }> }) =>
  f.calls.some((call) => writes.includes(call.operation));

test("the next prepare completes a deployment whose outgoing task ECS stopped, then proceeds", async () => {
  const f = await stranded();
  await f.expire();
  expect(await f.next().prepare()).toEqual({ kind: "warming" });
  expect(f.state.rows.old).toMatchObject({
    role: "retired",
    retirementContinuation: {
      reason: "outgoing_task_stopped",
      taskStatus: "stopped",
      stoppedReason: "Task failed ELB health checks",
      stoppedAt: "2026-10-29T12:00:00.000Z",
      lostWorkCounts: lostCounts,
      continuedBy: "run-3",
    },
  });
  expect(f.state.rows.old.retirementAcknowledgment).toBeUndefined();
  expect(f.state.ctl.deployment).toMatchObject({
    runToken: "run-3",
    phase: "warming",
    outgoing: candidateIdentity,
  });
  expect(f.warnings).toEqual([
    expect.stringMatching(/^::warning .*finalization=1/),
  ]);
  expect(
    f.calls.some((call) =>
      ["stop-task", "update-task-protection", "delete-item"].includes(
        call.operation,
      ),
    ),
  ).toBe(false);
});

test("the standalone command prints the warning and result and leaves the next deploy free", async () => {
  const f = await stranded();
  await f.expire();
  const output = { ...console, log: jest.fn(), error: jest.fn() };
  expect(
    await runCli(
      "continue-stopped-outgoing",
      { ...f.options, env: nextRun },
      output,
    ),
  ).toBe(0);
  expect(output.error).not.toHaveBeenCalled();
  expect(output.log.mock.calls[0][0]).toMatch(/^::warning title=/);
  expect(output.log.mock.calls[0][0]).not.toContain("ELB");
  expect(JSON.parse(output.log.mock.calls[1][0])).toEqual({
    kind: "continued",
    taskStatus: "stopped",
    lostWorkCounts: lostCounts,
  });
  expect(f.state.ctl.deployment).toMatchObject({
    runToken: "run-2",
    phase: "complete",
  });
  expect(f.state.ctl.coordinatorToken).toBe("run-2");
});

test("the failed run's own token may continue before its lease expires", async () => {
  const f = await stranded();
  f.state.ctl.coordinatorExpiresAt = f.options.now() + 100;
  const own = createCoordinator({ ...f.options, warn: jest.fn() });
  expect(await own.continueStoppedOutgoing()).toMatchObject({
    kind: "continued",
  });
  expect(f.state.ctl.deployment?.phase).toBe("complete");
});

test("a live previous coordinator lease refuses continuation", async () => {
  const f = await stranded();
  f.state.ctl.coordinatorExpiresAt = f.options.now() + 100;
  await expect(f.next().continueStoppedOutgoing()).rejects.toMatchObject({
    category: "continuation_refused",
    message: "Previous coordinator lease is still live",
  });
  expect(wrote(f)).toBe(false);
});

test.each([
  ["running", "Only the promoted candidate task may be running"],
  ["stopping", "Outgoing ECS task must be STOPPED"],
] as const)(
  "an outgoing task that is %s refuses continuation",
  async (task, message) => {
    const f = await stranded();
    await f.expire();
    f.state.outgoingTask = task;
    await expect(f.next().prepare()).rejects.toMatchObject({
      category: "continuation_refused",
      message,
    });
    expect(wrote(f)).toBe(false);
    expect(f.state.ctl.deployment?.phase).toBe("retiring");
  },
);

test("an ECS deployment still rolling out refuses continuation", async () => {
  const f = await stranded();
  await f.expire();
  f.svc.deployments = [
    { rolloutState: "IN_PROGRESS" },
    { rolloutState: "COMPLETED" },
  ];
  await expect(f.next().prepare()).rejects.toMatchObject({
    category: "continuation_refused",
    message: "ECS service must be converged on the candidate with no rollout",
  });
  expect(wrote(f)).toBe(false);
});

test("a candidate that is not serving refuses continuation", async () => {
  const f = await stranded();
  await f.expire();
  f.state.rows.new.role = "draining";
  await expect(f.next().prepare()).rejects.toMatchObject({
    category: "continuation_refused",
    message: "Promoted candidate must be serving and ready",
  });
  expect(wrote(f)).toBe(false);
});

test("a pruned outgoing task counts as stopped only after its heartbeat outlives protection", async () => {
  const f = await stranded();
  await f.expire();
  f.state.outgoingTask = "missing";
  f.state.rows.old.heartbeatAt = f.options.now() - 60;
  await expect(f.next().continueStoppedOutgoing()).rejects.toMatchObject({
    message: "Missing outgoing task still has a recent heartbeat",
  });
  expect(wrote(f)).toBe(false);
  f.state.rows.old.heartbeatAt = f.options.now() - 600;
  expect(await f.next().continueStoppedOutgoing()).toMatchObject({
    kind: "continued",
    taskStatus: "missing",
  });
  expect(f.state.rows.old.retirementContinuation).not.toHaveProperty(
    "stoppedAt",
  );
});

test("prepare waits for a quiet serving runtime and refuses before any write", async () => {
  const f = fixture();
  f.state.rows.old.workCounts = { ...counts(), finalization: 1 };
  await expect(f.coordinator.prepare()).rejects.toMatchObject({
    category: "outgoing_busy",
  });
  expect(
    f.calls.some((call) =>
      ["update-item", "register-task-definition", "update-service"].includes(
        call.operation,
      ),
    ),
  ).toBe(false);
  expect(f.state.ctl.deployment).toBeUndefined();
});

test("prepare proceeds once the serving runtime finishes its recording", async () => {
  const f = fixture();
  f.state.rows.old.workCounts = counts(1);
  f.state.onSleep = () => {
    f.state.rows.old.workCounts = counts();
  };
  expect(await f.coordinator.prepare()).toEqual({ kind: "warming" });
  expect(f.state.ctl.deployment?.phase).toBe("warming");
});

test("work outside recording, finalization and voice does not hold the handoff", async () => {
  const f = fixture();
  f.state.rows.old.workCounts = { ...counts(), personal_processing: 2 };
  expect(await f.coordinator.prepare()).toEqual({ kind: "warming" });
});

test("a coordinator that acquires the environment during the quiet wait keeps it", async () => {
  const f = fixture();
  f.state.rows.old.workCounts = counts(1);
  f.state.onSleep = () => {
    f.state.rows.old.workCounts = counts();
    f.state.ctl.coordinatorToken = "other";
    f.state.ctl.coordinatorExpiresAt = f.options.now() + 180;
  };
  await expect(f.coordinator.prepare()).rejects.toMatchObject({
    category: "coordinator_authority_changed",
  });
  expect(f.state.ctl.coordinatorToken).toBe("other");
});
