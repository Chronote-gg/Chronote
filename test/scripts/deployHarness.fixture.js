import { marshall } from "@aws-sdk/util-dynamodb";
import { createDeploy } from "../../scripts/deployment/deploy.cjs";

export const MINUTE_MS = 60_000;
export const START_MS = Date.UTC(2030, 0, 1);
export const FAMILY = "example-test-bot-task";
export const CURRENT_ARN = `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:7`;
export const OLD_ARN = `arn:aws:ecs:us-east-1:000000000000:task-definition/${FAMILY}:6`;
export const BOUND_GROUP = "arn:aws:elasticloadbalancing:tg/example-a";
export const OTHER_GROUP = "arn:aws:elasticloadbalancing:tg/example-b";
export const PREVIOUS_IMAGE = `repo@sha256:${"a".repeat(64)}`;
export const NEW_IMAGE = `repo@sha256:${"b".repeat(64)}`;
export const CUTOVER = marshall({
  pk: "WORKERS",
  sk: "CUTOVER",
  recordType: "cutover",
});
export const MARKER_READ_ATTEMPTS = 3;

export function failingReads(failures, then) {
  let calls = 0;
  return (clock) => {
    calls += 1;
    if (calls <= failures) throw new Error("ProvisionedThroughputExceeded");
    return then(clock);
  };
}

export const env = {
  ECS_CLUSTER: "example-cluster",
  ECS_SERVICE: "example-service",
  ECS_TASK_FAMILY: FAMILY,
  DEPLOYMENT_LISTENER_ARN: "arn:aws:elasticloadbalancing:listener/example",
  DEPLOYMENT_CONTROL_TABLE: "example-test-DeploymentControlTable",
  SECRETS_PREFIX: "example-test",
};

export function taskDefinition(revision, image) {
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

export function worker(instanceId, fields) {
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

export function harness(overrides = {}) {
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
