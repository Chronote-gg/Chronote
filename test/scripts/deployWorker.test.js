/** @jest-environment node */
import { describe, expect, test } from "@jest/globals";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createDeploy } from "../../scripts/deployment/deploy.cjs";

const MINUTE_MS = 60_000;
const START_MS = Date.UTC(2030, 0, 1);
const FAMILY = "example-test-bot-task";
const CURRENT_ARN = `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:7`;
const OLD_ARN = `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:6`;
const BOUND_GROUP = "arn:aws:elasticloadbalancing:tg/example-a";
const OTHER_GROUP = "arn:aws:elasticloadbalancing:tg/example-b";
const PREVIOUS_IMAGE = `repo@sha256:${"a".repeat(64)}`;
const NEW_IMAGE = `repo@sha256:${"b".repeat(64)}`;
const CUTOVER = marshall({
  pk: "WORKERS",
  sk: "CUTOVER",
  recordType: "cutover",
});
const MARKER_READ_ATTEMPTS = 3;

function failingReads(failures, then) {
  let calls = 0;
  return (clock) => {
    calls += 1;
    if (calls <= failures) throw new Error("ProvisionedThroughputExceeded");
    return then(clock);
  };
}

const env = {
  ECS_CLUSTER: "example-cluster",
  ECS_SERVICE: "example-service",
  ECS_TASK_FAMILY: FAMILY,
  DEPLOYMENT_LISTENER_ARN: "arn:aws:elasticloadbalancing:listener/example",
  DEPLOYMENT_CONTROL_TABLE: "example-test-DeploymentControlTable",
  SECRETS_PREFIX: "example-test",
};

function taskDefinition(revision, image) {
  return {
    taskDefinitionArn: `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:${revision}`,
    family: FAMILY,
    revision,
    status: "ACTIVE",
    requiresAttributes: [{ name: "x" }],
    compatibilities: ["FARGATE"],
    registeredAt: "2030-01-01T00:00:00Z",
    registeredBy: "arn:aws:iam::000000000000:role/example",
    cpu: "512",
    containerDefinitions: [
      {
        name: "bot",
        image,
        environment: [
          { name: "DDB_TABLE_PREFIX", value: "example-test-" },
          { name: "DEPLOYMENT_CANDIDATE_ID", value: "old-candidate" },
          { name: "KEEP", value: "1" },
        ],
      },
      {
        name: "sidecar",
        image: "sidecar:1",
        environment: [{ name: "DEPLOYMENT_CANDIDATE_ID", value: "old" }],
      },
    ],
  };
}

function worker(instanceId, fields) {
  return marshall({
    pk: "WORKERS",
    sk: `WORKER#${instanceId}`,
    recordType: "worker",
    instanceId,
    release: 7,
    ready: true,
    heartbeatAt: Math.floor(START_MS / 1000),
    captures: 0,
    finishing: 0,
    ...fields,
  });
}

function harness(overrides = {}) {
  let clock = START_MS;
  const calls = [];
  const logs = [];
  const outputs = [];
  const state = {
    service: {
      serviceName: env.ECS_SERVICE,
      status: "ACTIVE",
      taskDefinition: CURRENT_ARN,
      loadBalancers: [{ targetGroupArn: BOUND_GROUP }],
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: true, rollback: false },
        minimumHealthyPercent: 50,
        maximumPercent: 100,
      },
    },
    listenerGroups: [
      { TargetGroupArn: BOUND_GROUP, Weight: 100 },
      { TargetGroupArn: OTHER_GROUP, Weight: 0 },
    ],
    tasks: [],
    registry: () => [CUTOVER],
    latestRevision: 7,
    servingImage: PREVIOUS_IMAGE,
    stopping: new Map(),
    definitions: {},
    ...overrides,
  };
  const handlers = {
    "ecs.describe-services": () => ({
      services: state.service ? [state.service] : [],
      failures: state.service ? [] : [{ reason: "MISSING" }],
    }),
    "elbv2.describe-listeners": () => ({
      Listeners: [
        {
          DefaultActions: [
            {
              Type: "forward",
              ForwardConfig: { TargetGroups: state.listenerGroups },
            },
          ],
        },
      ],
    }),
    "ecs.list-tasks": ({ desiredStatus }) => ({
      taskArns: state.tasks
        .filter(
          (t) => desiredStatus !== "RUNNING" || t.lastStatus !== "STOPPED",
        )
        .map((t) => t.taskArn),
    }),
    "ecs.describe-tasks": ({ tasks }) => ({
      tasks: state.tasks.filter((t) => tasks.includes(t.taskArn)),
    }),
    // A stopped task stays listed for two more polls, as ECS keeps it while it shuts down.
    "ecs.stop-task": ({ task }) => {
      state.stopping.set(task, 0);
      return {};
    },
    "cloudwatch.put-metric-data": () => ({}),
    "dynamodb.query": () => ({ Items: state.registry(clock) }),
    "ecs.describe-task-definition": ({ taskDefinition: ref }) => ({
      taskDefinition:
        state.definitions[ref] ??
        (ref === FAMILY
          ? taskDefinition(state.latestRevision, "repo@sha256:latest")
          : taskDefinition(7, state.servingImage)),
    }),
    "ecs.register-task-definition": (input) => ({
      taskDefinition: {
        ...input,
        taskDefinitionArn: `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:${state.latestRevision + 1}`,
        revision: state.latestRevision + 1,
      },
    }),
    "ecs.update-service": (params) => {
      if (state.updateError) {
        if (state.updateError.accepted)
          state.service.taskDefinition = params.taskDefinition;
        throw new Error(state.updateError.message);
      }
      state.service.taskDefinition = params.taskDefinition;
      return {};
    },
  };
  const deploy = createDeploy({
    aws: async (service, operation, params) => {
      calls.push({ name: `${service}.${operation}`, params });
      const handler = handlers[`${service}.${operation}`];
      if (!handler) throw new Error(`unexpected ${service}.${operation}`);
      return handler(params, state);
    },
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      for (const [task, sleeps] of state.stopping)
        state.stopping.set(task, sleeps + 1);
      state.tasks = state.tasks.filter(
        (t) => !(state.stopping.get(t.taskArn) >= 2),
      );
      if (state.onSleep) state.onSleep(clock, state);
    },
    log: (line) => logs.push(line),
    output: (value) => outputs.push({ value, afterCalls: calls.length }),
  });
  const named = (name) => calls.filter((c) => c.name === name);
  return {
    deploy,
    calls,
    named,
    logs,
    outputs,
    state,
    elapsed: () => clock - START_MS,
  };
}

describe("preflight", () => {
  test("preflight passes when the bound group has full weight", async () => {
    const { deploy } = harness();
    await expect(deploy.preflight()).resolves.toBeUndefined();
  });
  test("preflight refuses a mismatched target group", async () => {
    const { deploy } = harness({
      listenerGroups: [
        { TargetGroupArn: BOUND_GROUP, Weight: 0 },
        { TargetGroupArn: OTHER_GROUP, Weight: 100 },
      ],
    });
    await expect(deploy.preflight()).rejects.toThrow(/target group/);
  });
  test("preflight refuses split traffic", async () => {
    const { deploy } = harness({
      listenerGroups: [
        { TargetGroupArn: BOUND_GROUP, Weight: 50 },
        { TargetGroupArn: OTHER_GROUP, Weight: 50 },
      ],
    });
    await expect(deploy.preflight()).rejects.toThrow(/target group/);
  });
  test("preflight refuses a missing or inactive service", async () => {
    await expect(harness({ service: null }).deploy.preflight()).rejects.toThrow(
      /not found/,
    );
    const inactive = harness();
    inactive.state.service.status = "DRAINING";
    await expect(inactive.deploy.preflight()).rejects.toThrow(/DRAINING/);
  });
  test("preflight passes for a service with no load balancer", async () => {
    const h = harness();
    h.state.service.loadBalancers = [];
    await expect(h.deploy.preflight()).resolves.toBeUndefined();
    expect(h.named("elbv2.describe-listeners")).toHaveLength(0);
  });
});

describe("wait-drain", () => {
  test("drain wait returns when no older task runs", async () => {
    const h = harness({
      tasks: [
        {
          taskArn: "task/new",
          taskDefinitionArn: CURRENT_ARN,
          lastStatus: "RUNNING",
        },
        {
          taskArn: "task/old",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
      ],
      onSleep: (clock, state) => {
        if (clock - START_MS >= 10 * MINUTE_MS)
          state.tasks = state.tasks.filter((t) => t.taskArn !== "task/old");
      },
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.named("ecs.list-tasks")[0].params.desiredStatus).toBe("RUNNING");
    expect(h.named("cloudwatch.put-metric-data")).toHaveLength(0);
    expect(h.named("ecs.stop-task")).toHaveLength(0);
    expect(h.logs.some((line) => /1 older task draining/.test(line))).toBe(
      true,
    );
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
  });
  test("drain wait times out at 160 minutes and publishes the metric", async () => {
    const h = harness({
      tasks: [
        {
          taskArn: "task/old",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
      ],
    });
    await expect(h.deploy.waitDrain()).rejects.toThrow(/160 minutes/);
    expect(h.elapsed()).toBeGreaterThanOrEqual(160 * MINUTE_MS);
    expect(h.elapsed()).toBeLessThan(162 * MINUTE_MS);
    const metric = h.named("cloudwatch.put-metric-data");
    expect(metric).toHaveLength(1);
    expect(metric[0].params).toEqual({
      Namespace: "example-test/Deploy",
      MetricData: [
        { MetricName: "DrainWaitTimedOut", Value: 1, Unit: "Count" },
      ],
    });
    // The marker read and the first evaluation's registry read; a task seen
    // draining needs no further read, and the protection wait is never reached.
    expect(h.named("dynamodb.query")).toHaveLength(2);
  });
  test("drain wait without the cutover marker does not wait for the old runtime or retire it", async () => {
    const h = harness({
      registry: () => [],
      tasks: [
        {
          taskArn: "task/old-runtime",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
      ],
    });
    await expect(h.deploy.waitDrain({ retire: true })).resolves.toBeUndefined();
    expect(h.elapsed()).toBe(0);
    expect(h.named("ecs.stop-task")).toHaveLength(0);
    expect(h.named("ecs.list-tasks")).toHaveLength(0);
    expect(
      h.logs.some((line) => /old runtime is still in charge/.test(line)),
    ).toBe(true);
    expect(
      h.logs.some((line) =>
        /retire is not available before the cutover/.test(line),
      ),
    ).toBe(true);
  });
  test("drain wait with an unreadable cutover marker waits as before", async () => {
    const h = harness({
      registry: failingReads(MARKER_READ_ATTEMPTS, () => []),
      tasks: [
        {
          taskArn: "task/old",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
      ],
      onSleep: (clock, state) => {
        if (clock - START_MS >= 10 * MINUTE_MS) state.tasks = [];
      },
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    expect(h.named("ecs.stop-task")).toHaveLength(0);
    expect(h.logs.some((line) => /could not be read/.test(line))).toBe(true);
  });
  test("wait-drain with an unreadable marker and --retire stops nothing and exits non-zero", async () => {
    const h = harness({
      registry: failingReads(MARKER_READ_ATTEMPTS, () => []),
      tasks: [
        {
          taskArn: "task/old",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
      ],
    });
    await expect(h.deploy.waitDrain({ retire: true })).rejects.toThrow(
      /cutover state could not be read.*retiring older tasks was refused.*nothing was stopped/,
    );
    expect(h.named("ecs.stop-task")).toHaveLength(0);
    expect(h.named("ecs.list-tasks")).toHaveLength(0);
  });
  test("retire stops each draining task once", async () => {
    const h = harness({
      tasks: [
        {
          taskArn: "task/a",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
        {
          taskArn: "task/b",
          taskDefinitionArn: OLD_ARN,
          lastStatus: "RUNNING",
        },
        {
          taskArn: "task/new",
          taskDefinitionArn: CURRENT_ARN,
          lastStatus: "RUNNING",
        },
      ],
    });
    await expect(h.deploy.waitDrain({ retire: true })).resolves.toBeUndefined();
    const stops = h.named("ecs.stop-task").map((c) => c.params.task);
    expect(stops.sort()).toEqual(["task/a", "task/b"]);
    expect(h.named("ecs.stop-task")[0].params.reason).toMatch(/deployment/);
    expect(
      h.logs.filter((line) => /2 older tasks draining/.test(line)),
    ).toHaveLength(2);
  });
  describe("an older task that is still the serving worker", () => {
    const OLD_TASK = {
      taskArn: "task/old",
      taskDefinitionArn: OLD_ARN,
      lastStatus: "RUNNING",
    };
    const freshSeconds = (clock) => Math.floor(clock / 1000);
    const servingHarness = (records, overrides = {}) =>
      harness({
        tasks: [{ ...OLD_TASK }],
        registry: (clock) => [CUTOVER, ...records(freshSeconds(clock))],
        ...overrides,
      });
    const oldRecord = (nowSeconds, fields = {}) =>
      worker("i-old", {
        release: 6,
        taskArn: OLD_TASK.taskArn,
        heartbeatAt: nowSeconds,
        ...fields,
      });
    const stopsAtTenMinutes = (clock, state) => {
      if (clock - START_MS >= 10 * MINUTE_MS) state.tasks = [];
    };

    test.each([false, true])(
      "is neither waited for nor retired (retire %s)",
      async (retire) => {
        const h = servingHarness((now) => [
          oldRecord(now),
          worker("i-failed", { release: 7, ready: false, heartbeatAt: now }),
        ]);
        await expect(h.deploy.waitDrain({ retire })).resolves.toBeUndefined();
        expect(h.elapsed()).toBe(0);
        expect(h.named("ecs.stop-task")).toHaveLength(0);
        expect(h.named("cloudwatch.put-metric-data")).toHaveLength(0);
        expect(
          h.logs.filter((line) =>
            /task\/old is the serving worker.*not waited for/.test(line),
          ),
        ).toHaveLength(1);
      },
    );
    test("is waited for and retired once a newer release is ready", async () => {
      const records = (now) => [
        oldRecord(now),
        worker("i-new", { release: 7, heartbeatAt: now }),
      ];
      const waiting = servingHarness(records, { onSleep: stopsAtTenMinutes });
      await expect(waiting.deploy.waitDrain()).resolves.toBeUndefined();
      expect(waiting.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
      const retiring = servingHarness(records);
      await retiring.deploy.waitDrain({ retire: true });
      expect(retiring.named("ecs.stop-task").map((c) => c.params.task)).toEqual(
        ["task/old"],
      );
    });
    test.each([
      ["stale", (now) => [oldRecord(now, { heartbeatAt: now - 31 })]],
      ["not ready", (now) => [oldRecord(now, { ready: false })]],
      ["missing", () => []],
    ])("is waited for when its record is %s", async (_, records) => {
      const h = servingHarness(records, { onSleep: stopsAtTenMinutes });
      await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
      expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    });
    test("the rollout proceeds after a drain wait that skipped it", async () => {
      const h = servingHarness((now) => [oldRecord(now)]);
      await h.deploy.waitDrain({ retire: true });
      await expect(h.deploy.rollout({ image: NEW_IMAGE })).resolves.toEqual({
        revision: 8,
        previousImage: PREVIOUS_IMAGE,
      });
      expect(h.named("ecs.stop-task")).toHaveLength(0);
    });
    test("a real drain keeps waiting when the newer record is stale for one poll", async () => {
      const staleAt = START_MS + 30_000;
      const h = servingHarness(
        (now) => [
          oldRecord(now),
          worker("i-new", {
            release: 7,
            heartbeatAt: now * 1000 === staleAt ? now - 31 : now,
          }),
        ],
        { onSleep: stopsAtTenMinutes },
      );
      await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
      expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
      expect(h.logs.some((line) => /not waited for/.test(line))).toBe(false);
    });
    test("a serving task becomes draining once a newer worker is ready", async () => {
      const readyAt = START_MS + 2 * MINUTE_MS;
      const h = servingHarness(
        (now) => [
          oldRecord(now),
          ...(now * 1000 >= readyAt
            ? [worker("i-new", { release: 7, heartbeatAt: now })]
            : []),
        ],
        { tasks: [{ ...OLD_TASK }, { ...OLD_TASK, taskArn: "task/older" }] },
      );
      h.state.onSleep = stopsAtTenMinutes;
      await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
      expect(h.elapsed()).toBeGreaterThanOrEqual(10 * MINUTE_MS);
    });
  });
  test("protection wait proceeds after five minutes", async () => {
    const h = harness({
      registry: (clock) => [
        worker("i-capturing", {
          captures: 1,
          heartbeatAt: Math.floor(clock / 1000),
        }),
      ],
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBeGreaterThanOrEqual(5 * MINUTE_MS);
    expect(h.elapsed()).toBeLessThan(6 * MINUTE_MS);
    expect(h.named("dynamodb.query")[0].params).toMatchObject({
      TableName: env.DEPLOYMENT_CONTROL_TABLE,
      ConsistentRead: true,
    });
  });
  test("protection wait returns once captures report protection", async () => {
    const h = harness({
      registry: (clock) => [
        worker("i-capturing", {
          captures: 1,
          heartbeatAt: Math.floor(clock / 1000),
          protectedUntil: Math.floor(clock / 1000) + 600,
        }),
        worker("i-stale", { captures: 2, heartbeatAt: 0 }),
      ],
    });
    await expect(h.deploy.waitDrain()).resolves.toBeUndefined();
    expect(h.elapsed()).toBe(0);
  });
});

describe("rollout", () => {
  test("rollout keeps early success with deferred cleanup", async () => {
    const h = harness();
    const result = await h.deploy.rollout({ image: NEW_IMAGE });
    expect(result).toEqual({ revision: 8, previousImage: PREVIOUS_IMAGE });
    const [update] = h.named("ecs.update-service");
    expect(update.params).toEqual({
      cluster: env.ECS_CLUSTER,
      service: env.ECS_SERVICE,
      taskDefinition: `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:8`,
      healthCheckGracePeriodSeconds: 300,
      deploymentConfiguration: {
        deploymentCircuitBreaker: { enable: false, rollback: false },
        minimumHealthyPercent: 100,
        maximumPercent: 200,
        earlySuccessCriteria: {
          enable: true,
          healthyPercent: 100,
          sourceServiceRevisionCleanup: "DEFERRED",
        },
      },
    });
  });
  test("rollout never changes the load balancer binding or desired count", async () => {
    const h = harness();
    await h.deploy.rollout({ image: NEW_IMAGE });
    const [update] = h.named("ecs.update-service");
    expect(update.params).not.toHaveProperty("loadBalancers");
    expect(update.params).not.toHaveProperty("desiredCount");
    expect(update.params).not.toHaveProperty("forceNewDeployment");
    expect(h.named("elbv2.modify-listener")).toHaveLength(0);
  });
  test("rollout starts from the latest family revision and sets the application image", async () => {
    const h = harness();
    await h.deploy.rollout({ image: NEW_IMAGE });
    expect(
      h.named("ecs.describe-task-definition").map((c) => c.params),
    ).toContainEqual({ taskDefinition: FAMILY });
    const [register] = h.named("ecs.register-task-definition");
    const input = register.params;
    for (const field of [
      "taskDefinitionArn",
      "revision",
      "status",
      "requiresAttributes",
      "compatibilities",
      "registeredAt",
      "registeredBy",
    ])
      expect(input).not.toHaveProperty(field);
    expect(input.cpu).toBe("512");
    expect(input.containerDefinitions[0].image).toBe(NEW_IMAGE);
    expect(input.containerDefinitions[1].image).toBe("sidecar:1");
  });
  test("rollout strips DEPLOYMENT_CANDIDATE_ID", async () => {
    const h = harness();
    await h.deploy.rollout({ image: NEW_IMAGE });
    const [register] = h.named("ecs.register-task-definition");
    for (const container of register.params.containerDefinitions)
      expect(container.environment.map((entry) => entry.name)).not.toContain(
        "DEPLOYMENT_CANDIDATE_ID",
      );
    expect(register.params.containerDefinitions[0].environment).toEqual([
      { name: "DDB_TABLE_PREFIX", value: "example-test-" },
      { name: "KEEP", value: "1" },
    ]);
  });
  test("rollout prints the previous image before updating the service", async () => {
    const h = harness();
    await h.deploy.rollout({ image: NEW_IMAGE });
    const updateIndex = h.calls.findIndex(
      (c) => c.name === "ecs.update-service",
    );
    expect(h.outputs[0]).toEqual({
      value: {
        previousImage: PREVIOUS_IMAGE,
        previousTaskDefinition: CURRENT_ARN,
        cutover: "present",
      },
      afterCalls: updateIndex,
    });
  });
  test("rollout succeeds when ECS accepted an update that reported an error", async () => {
    const h = harness({
      updateError: { accepted: true, message: "connection reset" },
    });
    await expect(h.deploy.rollout({ image: NEW_IMAGE })).resolves.toEqual({
      revision: 8,
      previousImage: PREVIOUS_IMAGE,
    });
    expect(h.named("ecs.describe-services").length).toBeGreaterThan(1);
  });
  test("rollout rethrows an update error ECS did not accept", async () => {
    const h = harness({
      updateError: { accepted: false, message: "AccessDenied" },
    });
    await expect(h.deploy.rollout({ image: NEW_IMAGE })).rejects.toThrow(
      /AccessDenied/,
    );
    expect(h.outputs.map((o) => o.value)).toEqual([
      {
        previousImage: PREVIOUS_IMAGE,
        previousTaskDefinition: CURRENT_ARN,
        cutover: "present",
      },
    ]);
  });
  test.each([
    ["absent", failingReads(1, () => [])],
    ["unknown", failingReads(MARKER_READ_ATTEMPTS, () => [CUTOVER])],
  ])(
    "rollout records the marker as %s before updating the service",
    async (cutover, registry) => {
      const h = harness({ registry });
      await expect(h.deploy.rollout({ image: NEW_IMAGE })).resolves.toEqual({
        revision: 8,
        previousImage: PREVIOUS_IMAGE,
      });
      expect(h.outputs[0].value.cutover).toBe(cutover);
      expect(h.named("dynamodb.query")).toHaveLength(
        cutover === "absent" ? 2 : MARKER_READ_ATTEMPTS,
      );
    },
  );
  test("rollout refuses an image without a digest", async () => {
    const h = harness();
    await expect(h.deploy.rollout({ image: "repo:latest" })).rejects.toThrow(
      /digest/,
    );
    expect(h.calls).toHaveLength(0);
  });
});

describe("wait-ready", () => {
  test("ready wait needs a fresh ready record on the new release", async () => {
    const h = harness({
      registry: (clock) => {
        const nowSeconds = Math.floor(clock / 1000);
        const items = [
          worker("i-old", { release: 7, heartbeatAt: nowSeconds }),
          worker("i-stale", { release: 8, heartbeatAt: nowSeconds - 31 }),
          worker("i-starting", {
            release: 8,
            ready: false,
            heartbeatAt: nowSeconds,
          }),
        ];
        if (clock - START_MS >= 2 * MINUTE_MS)
          items.push(worker("i-new", { release: 8, heartbeatAt: nowSeconds }));
        return items;
      },
    });
    await expect(h.deploy.waitReady({ release: 8 })).resolves.toBeUndefined();
    expect(h.elapsed()).toBe(2 * MINUTE_MS);
  });
  test("ready wait survives a registry read that fails once", async () => {
    const h = harness({
      registry: failingReads(1, (clock) => [
        worker("i-new", { release: 8, heartbeatAt: Math.floor(clock / 1000) }),
      ]),
    });
    await expect(h.deploy.waitReady({ release: 8 })).resolves.toBeUndefined();
    expect(h.named("dynamodb.query")).toHaveLength(2);
  });
  test("ready wait fails after three failed registry reads", async () => {
    const h = harness({
      registry: failingReads(MARKER_READ_ATTEMPTS, () => []),
    });
    await expect(h.deploy.waitReady({ release: 8 })).rejects.toThrow(
      /ProvisionedThroughputExceeded/,
    );
    expect(h.named("dynamodb.query")).toHaveLength(MARKER_READ_ATTEMPTS);
  });
  test("ready wait times out after 15 minutes", async () => {
    const h = harness({
      registry: (clock) => [
        worker("i-old", { release: 7, heartbeatAt: Math.floor(clock / 1000) }),
      ],
    });
    await expect(h.deploy.waitReady({ release: 8 })).rejects.toThrow(
      /15 minutes/,
    );
    expect(h.elapsed()).toBeGreaterThanOrEqual(15 * MINUTE_MS);
    expect(h.elapsed()).toBeLessThan(15 * MINUTE_MS + 20_000);
  });
  test("the cutover item is ignored by the ready wait", async () => {
    const h = harness({
      registry: (clock) => [
        marshall({
          pk: "WORKERS",
          sk: "CUTOVER",
          recordType: "cutover",
          release: 8,
          ready: true,
          heartbeatAt: Math.floor(clock / 1000),
        }),
      ],
    });
    await expect(h.deploy.waitReady({ release: 8 })).rejects.toThrow(
      /15 minutes/,
    );
  });
});

describe("rollback", () => {
  const arn = (revision) =>
    `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:${revision}`;
  const withEnvironment = (definition, name, value) => {
    const [application] = definition.containerDefinitions;
    application.environment = application.environment.map((entry) =>
      entry.name === name ? { name, value } : entry,
    );
    return definition;
  };
  /** The service is on the failed revision 8; rollout was on revision 7. */
  function rollbackHarness({
    failed = taskDefinition(8, NEW_IMAGE),
    ...overrides
  } = {}) {
    const previous = taskDefinition(7, PREVIOUS_IMAGE);
    const h = harness({
      latestRevision: 8,
      definitions: {
        [FAMILY]: failed,
        [failed.taskDefinitionArn]: failed,
        [previous.taskDefinitionArn]: previous,
      },
      ...overrides,
    });
    h.state.service.taskDefinition = failed.taskDefinitionArn;
    return h;
  }
  const rollBack = (h, options = {}) =>
    h.deploy.rollback({
      image: PREVIOUS_IMAGE,
      previousTaskDefinition: arn(7),
      rolloutCutover: "present",
      ...options,
    });
  const expectNothingChanged = (h) => {
    expect(h.named("ecs.register-task-definition")).toHaveLength(0);
    expect(h.named("ecs.update-service")).toHaveLength(0);
  };

  test("rollback changes nothing when the service is still on the previous revision", async () => {
    const h = rollbackHarness();
    h.state.service.taskDefinition = arn(7);
    await expect(rollBack(h)).rejects.toThrow(
      /never moved off the previous revision/,
    );
    expectNothingChanged(h);
  });
  test("rollback registers a higher revision when only the image changed", async () => {
    const h = rollbackHarness();
    await expect(rollBack(h)).rejects.toThrow(/rolled back.*revision 9/i);
    const [register] = h.named("ecs.register-task-definition");
    expect(register.params.containerDefinitions[0].image).toBe(PREVIOUS_IMAGE);
    const [update] = h.named("ecs.update-service");
    expect(update.params.taskDefinition).toMatch(/:9$/);
  });
  test.each([
    ["the image did not change", () => taskDefinition(8, PREVIOUS_IMAGE)],
    [
      "the environment changed with the image",
      () => withEnvironment(taskDefinition(8, NEW_IMAGE), "KEEP", "2"),
    ],
  ])("rollback asks for a forward repair when %s", async (_, failed) => {
    const h = rollbackHarness({ failed: failed() });
    await expect(rollBack(h)).rejects.toThrow(
      /failure is in the task definition.*revision 8.*revision 7.*fix the configuration and deploy again/,
    );
    expectNothingChanged(h);
  });
  test("rollback refuses without the previous revision", async () => {
    const h = rollbackHarness();
    await expect(
      rollBack(h, { previousTaskDefinition: undefined }),
    ).rejects.toThrow(/--previous-task-definition is required/);
    expectNothingChanged(h);
  });
  test("rollback refuses when the marker was absent at rollout, even if it is present now", async () => {
    const h = rollbackHarness();
    await expect(rollBack(h, { rolloutCutover: "absent" })).rejects.toThrow(
      /old runtime is still in charge.*new deployment of a fixed commit/,
    );
    expectNothingChanged(h);
    expect(h.named("dynamodb.query")).toHaveLength(0);
  });
  test.each(["unknown", undefined])(
    "rollback refuses when the marker state at rollout was %s",
    async (rolloutCutover) => {
      const h = rollbackHarness();
      await expect(rollBack(h, { rolloutCutover })).rejects.toThrow(
        /cutover state could not be read.*nothing was changed/,
      );
      expectNothingChanged(h);
    },
  );
});

test("arguments parse into subcommand options", async () => {
  const { parseArguments } =
    await import("../../scripts/deployment/deploy.cjs");
  expect(parseArguments(["wait-drain", "--retire"])).toEqual({
    command: "wait-drain",
    options: { retire: true },
  });
  expect(parseArguments(["wait-ready", "--release", "12"])).toEqual({
    command: "wait-ready",
    options: { release: 12 },
  });
  expect(
    parseArguments([
      "rollback",
      "--image",
      PREVIOUS_IMAGE,
      "--previous-task-definition",
      OLD_ARN,
      "--rollout-cutover",
      "present",
    ]),
  ).toEqual({
    command: "rollback",
    options: {
      image: PREVIOUS_IMAGE,
      previousTaskDefinition: OLD_ARN,
      rolloutCutover: "present",
    },
  });
  expect(() => parseArguments(["rollout", "--force"])).toThrow(/Unknown/);
});
