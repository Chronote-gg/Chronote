/** @jest-environment node */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { routingFixture } from "../deployment/fixtures/routingFixture";
import {
  continueSandbox,
  continuationBinding,
  bindingHash,
  assertSandboxScope,
} from "../../scripts/deployment/continue-sandbox.cjs";
import { createCoordinator } from "../../scripts/deployment/coordinator.cjs";

const account = "123456789012";
const session = "chronote-sandbox-900-1";
const role = `arn:aws:iam::${account}:role/fixture-sandbox-github-deploy`;
async function fixture() {
  const f = routingFixture();
  await f.coordinator.prepare();
  f.svc.runningCount = 2;
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (service === "sts")
      return {
        Account: account,
        Arn:
          role.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/") +
          "/" +
          session,
      };
    return original(service, operation, input);
  });
  const options = {
    ...f.options,
    env: {
      ...f.options.env,
      AWS_REGION: "us-east-1",
      EXPECTED_ACCOUNT_ID: account,
      EXPECTED_ROLE_ARN: role,
      EXPECTED_SESSION_NAME: session,
      // Resource route is validated separately from fixture naming.
      CONTINUATION_BINDING_SHA256: "",
    },
  };
  return {
    ...f,
    options,
    hash: bindingHash(continuationBinding(f.state.ctl, f.candidateIdentity)),
    before: f.calls.length,
  };
}
const changes = (f: Awaited<ReturnType<typeof fixture>>) =>
  f.calls
    .slice(f.before)
    .filter(
      (call) =>
        !call.operation.startsWith("describe-") &&
        ![
          "get-item",
          "query",
          "list-tasks",
          "list-service-deployments",
          "get-task-protection",
        ].includes(call.operation),
    );

test("inspection is read-only and produces the frozen binding checksum", async () => {
  const f = await fixture();
  expect(
    await continueSandbox({
      ...f.options,
      mode: "inspect",
      validateScope: () => undefined,
    }),
  ).toMatchObject({ kind: "inspection", bindingSha256: f.hash });
  expect(changes(f)).toEqual([]);
});

test("continuation promotes and retires the same candidate without preparation", async () => {
  const f = await fixture();
  f.state.retirementAcknowledged = true;
  f.state.onSleep = () => {
    if (f.state.rows.old.role === "retired") f.svc.runningCount = 1;
  };
  expect(
    await continueSandbox({
      ...f.options,
      expectedBindingSha256: f.hash,
      validateScope: () => undefined,
    }),
  ).toMatchObject({ kind: "complete" });
  expect(f.state.ctl.deployment?.candidateId).toBe(
    f.candidateIdentity.candidateId,
  );
  expect(
    changes(f).some((call) =>
      [
        "register-task-definition",
        "update-service",
        "stop-task",
        "update-task-protection",
      ].includes(call.operation),
    ),
  ).toBe(false);
});

test.each([
  "hash",
  "phase",
  "membership",
  "unhealthy",
  "pending",
  "stale",
  "protection",
  "candidate",
  "submitted",
])("refuses %s before coordinator writes", async (kind) => {
  const f = await fixture();
  let expected = f.hash;
  if (kind === "hash") expected = "0".repeat(64);
  if (kind === "phase") f.state.ctl.deployment!.phase = "promoted";
  if (kind === "membership") f.state.ctl.servingGeneration++;
  if (kind === "unhealthy")
    f.traffic.candidateTargets[0].TargetHealth.State = "initial";
  if (kind === "pending") f.svc.pendingCount = 1;
  if (kind === "stale") f.state.rows.new.readiness.expiresAt = 0;
  if (kind === "protection") f.state.protected = false;
  if (kind === "candidate")
    f.state.rows.new.identity = {
      ...f.state.rows.new.identity,
      instanceId: "replaced",
    };
  if (kind === "submitted")
    f.state.ctl.deployment!.routing!.state = "forward_submitted";
  await expect(
    continueSandbox({
      ...f.options,
      expectedBindingSha256: expected,
      validateScope: () => undefined,
    }),
  ).rejects.toThrow();
  expect(changes(f)).toEqual([]);
});

test("unknown routing cannot be replayed or followed by retirement", async () => {
  const f = await fixture();
  f.traffic.unknown = true;
  await expect(
    continueSandbox({
      ...f.options,
      expectedBindingSha256: f.hash,
      validateScope: () => undefined,
    }),
  ).rejects.toThrow();
  expect(f.state.ctl.deployment?.routing?.state).toBe("forward_submitted");
  expect(f.state.rows.old.retirementRequest).toBeUndefined();
  expect(
    f.calls.filter((call) => call.operation === "modify-listener"),
  ).toHaveLength(1);
});

test.each(["control_epoch", "same_second_pending_task"])(
  "final preflight refusal cannot be swallowed by renewal recovery: %s",
  async (kind) => {
    const f = await fixture();
    let factories = 0;
    const coordinatorFactory = (
      options: Parameters<typeof createCoordinator>[0],
    ) => {
      if (++factories === 2) {
        if (kind === "control_epoch") f.state.ctl.coordinatorEpoch++;
        else f.svc.pendingCount = 1;
      }
      return createCoordinator(options);
    };
    await expect(
      continueSandbox({
        ...f.options,
        coordinatorFactory,
        expectedBindingSha256: f.hash,
        validateScope: () => undefined,
      }),
    ).rejects.toThrow();
    expect(changes(f)).toEqual([]);
    expect(f.state.ctl.deployment?.phase).toBe("warming");
  },
);

test.each(["empty_source", "stopped_source", "single_task"])(
  "missing outgoing runtime refuses continuation: %s",
  async (kind) => {
    const f = await fixture();
    if (kind === "empty_source") f.traffic.sourceTargets = [];
    if (kind === "single_task") f.svc.runningCount = 1;
    if (kind === "stopped_source") {
      const original = f.aws.getMockImplementation()!;
      f.aws.mockImplementation(async (service, operation, input) => {
        const result = await original(service, operation, input);
        if (operation === "describe-tasks") {
          const tasks = result as {
            tasks: { taskArn: string; lastStatus: string }[];
          };
          for (const task of tasks.tasks)
            if (task.taskArn === f.oldIdentity.taskArn)
              task.lastStatus = "STOPPED";
        }
        return result;
      });
    }
    await expect(
      continueSandbox({
        ...f.options,
        expectedBindingSha256: f.hash,
        validateScope: () => undefined,
      }),
    ).rejects.toThrow();
    expect(changes(f)).toEqual([]);
  },
);

test("binding excludes renewable timestamps and canonicalizes object keys", async () => {
  const f = await fixture();
  f.state.ctl.coordinatorExpiresAt++;
  f.state.ctl.deployment!.updatedAt++;
  const binding = continuationBinding(f.state.ctl, f.candidateIdentity);
  expect(bindingHash(binding)).toBe(f.hash);
  expect(
    bindingHash(Object.fromEntries(Object.entries(binding).reverse())),
  ).toBe(f.hash);
});

test("Sandbox scope refuses account, region, definition, resource and table drift", async () => {
  const f = await fixture();
  const ctl = structuredClone(f.state.ctl);
  const d = ctl.deployment!;
  const ecs = `arn:aws:ecs:us-east-1:${account}:`;
  const elb = `arn:aws:elasticloadbalancing:us-east-1:${account}:`;
  Object.assign(d, {
    cluster: "fixture-sandbox-cluster",
    service: "fixture-sandbox-service",
    family: "fixture-sandbox-task",
    tablePrefix: "fixture-sandbox-",
    taskDefinition: ecs + "task-definition/fixture-sandbox-task:29",
    previousTaskDefinition: ecs + "task-definition/fixture-sandbox-task:27",
    image: `${account}.dkr.ecr.us-east-1.amazonaws.com/fixture-sandbox-repo@${f.candidateIdentity.imageDigest}`,
    originalMembers: [
      { ...f.oldIdentity, taskArn: ecs + "task/fixture-sandbox-cluster/old" },
    ],
    routing: {
      ...d.routing,
      listenerArn: elb + "listener/app/fixture-sandbox/one/two",
      sourceGroup: elb + "targetgroup/fixture-sandbox-a/one",
      candidateGroup: elb + "targetgroup/fixture-sandbox-b/two",
    },
  });
  const env = {
    ...f.options.env,
    CONTINUATION_ENVIRONMENT: "sandbox",
    SECRETS_PREFIX: "fixture-sandbox",
    ECS_CLUSTER: d.cluster,
    ECS_SERVICE: d.service,
    ECS_TASK_FAMILY: d.family,
  };
  expect(() => assertSandboxScope(env, ctl)).not.toThrow();
  for (const patch of [
    { EXPECTED_ACCOUNT_ID: "999999999999" },
    { AWS_REGION: "us-west-2" },
    { CONTINUATION_ENVIRONMENT: "production" },
    { ECS_SERVICE: "foreign-sandbox" },
    { SECRETS_PREFIX: "production" },
  ]) {
    expect(() => assertSandboxScope({ ...env, ...patch }, ctl)).toThrow();
  }
});

test("foreign STS principal refuses before any coordinator operation", async () => {
  const f = await fixture();
  await expect(
    continueSandbox({
      ...f.options,
      env: {
        ...f.options.env,
        EXPECTED_SESSION_NAME: "chronote-sandbox-901-1",
      },
      expectedBindingSha256: f.hash,
      validateScope: () => undefined,
    }),
  ).rejects.toThrow();
  expect(changes(f)).toEqual([]);
});

test.each(["continue", "inspect"])(
  "workflow rejects mixed bootstrap and %s input before authentication",
  (action) => {
    const workflow = parse(
      readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
    );
    const validation = workflow.jobs.identity.steps.find(
      (step: { name: string }) =>
        step.name === "Validate exclusive operation inputs",
    ).run;
    const script = validation.split("node <<'NODE'\n")[1].split("\nNODE")[0];
    const { spawnSync } =
      jest.requireActual<typeof import("node:child_process")>(
        "node:child_process",
      );
    const env = {
      ...process.env,
      CONTINUATION_ACTION: action,
      CONTINUATION_BINDING_SHA256: action === "continue" ? "a".repeat(64) : "",
      GITHUB_RUN_ATTEMPT: "1",
      BOOTSTRAP_PHASE: "none",
    };
    expect(spawnSync(process.execPath, ["-e", script], { env }).status).toBe(0);
    for (const patch of [
      { BOOTSTRAP_PHASE: "repair" },
      { PROBE_WITHOUT_ENVIRONMENT: "true" },
      { GITHUB_RUN_ATTEMPT: "2" },
      { BOOTSTRAP_OPERATION_ID: "other" },
    ]) {
      expect(
        spawnSync(process.execPath, ["-e", script], {
          env: { ...env, ...patch },
        }).status,
      ).not.toBe(0);
    }
  },
);

test("workflow preserves the existing environment and has no image or preparation path", () => {
  const workflow = parse(
    readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
  );
  const job = workflow.jobs.continuation;
  expect(job.environment).toBe("sandbox");
  expect(workflow.concurrency).toEqual({
    group: "chronote-deploy-sandbox",
    "cancel-in-progress": false,
  });
  const source = JSON.stringify(job);
  expect(source).toContain("SANDBOX_BACKEND_DEPLOY_ROLE_ARN");
  expect(source).toContain("assert-sandbox-identity.cjs");
  expect(source).toContain("continue-sandbox.cjs");
  expect(source).not.toMatch(
    /docker build|docker push|force-new-deployment|coordinator\.cjs prepare/,
  );
});
