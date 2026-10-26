/** @jest-environment node */
import { expect, test, jest } from "@jest/globals";
import { randomUUID, createHash } from "node:crypto";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  bindJob,
  prepare,
  createIntroduction,
} from "../../scripts/deployment/introduce-sandbox.cjs";
function fixture() {
  const account = "123456789012",
    prefix = "test-sandbox-";
  const role = "test-sandbox-github-deploy",
    operationId = randomUUID();
  const session =
    "chronote-sandbox-" + BigInt("0x" + operationId.replaceAll("-", "")) + "-1";
  const ecs = "arn:aws:ecs:us-east-1:" + account + ":";
  const elb = "arn:aws:elasticloadbalancing:us-east-1:" + account + ":";
  const m = {
    environment: "sandbox",
    accountId: account,
    region: "us-east-1",
    principalArn:
      "arn:aws:sts::" + account + ":assumed-role/" + role + "/" + session,
    operationId,
    sourceCommit: "a".repeat(40),
    tablePrefix: prefix,
    bucket: "test-sandbox-bucket",
    cluster: "test-sandbox-cluster",
    service: "test-sandbox-service",
    containerName: "test-sandbox-bot",
    containerPort: 3001,
    legacyTaskDefinition: ecs + "task-definition/test-sandbox-task:1",
    taskDefinition: ecs + "task-definition/test-sandbox-task:2",
    imageDigest: "sha256:" + "b".repeat(64),
    runtimeMode: "all",
    listenerArn: elb + "listener/app/test-sandbox/1/2",
    targetGroupA: elb + "targetgroup/test-sandbox-a/1",
    targetGroupB: elb + "targetgroup/test-sandbox-b/2",
    maintenance: {
      testOnly: true,
      workSettled: true,
      receiptSha256: "c".repeat(64),
      confirmedAt: new Date(1000000).toISOString(),
    },
  };
  const runtimeIdentity = {
    kind: "ecs",
    instanceId: "runtime",
    protocolVersion: 1,
    candidateId: operationId,
    imageDigest: m.imageDigest,
    taskArn: ecs + "task/test-sandbox-cluster/runtime",
  };
  const hash = createHash("sha256").update(JSON.stringify(m)).digest("hex");
  const env = {
    BOOTSTRAP_PHASE: "activate",
    BOOTSTRAP_MANIFEST_JSON: JSON.stringify(m),
    BOOTSTRAP_MANIFEST_SHA256: hash,
    BOOTSTRAP_OPERATION_ID: operationId,
    GITHUB_SHA: m.sourceCommit,
    GITHUB_RUN_ID: "12",
    GITHUB_RUN_ATTEMPT: "1",
    EXPECTED_ACCOUNT_ID: account,
    EXPECTED_ROLE_ARN: "arn:aws:iam::" + account + ":role/" + role,
  };
  const state = {
    stage: null,
    stopped: false,
    routed: false,
    launched: false,
    historyCount: 0,
    lostStop: false,
    lostRoute: false,
    lateLegacy: "",
  };
  const calls = [];
  function lateLegacy(kind) {
    return state.lateLegacy === kind && state.stage?.stage === "stop_submitted";
  }
  const action = () => {
    const TargetGroups = state.routed
      ? [
          { TargetGroupArn: m.targetGroupA, Weight: 100 },
          { TargetGroupArn: m.targetGroupB, Weight: 0 },
        ]
      : [{ TargetGroupArn: m.targetGroupA, Weight: 1 }];
    return [
      {
        Type: "forward",
        ...(!state.routed && { TargetGroupArn: m.targetGroupA }),
        ForwardConfig: {
          TargetGroups,
          TargetGroupStickinessConfig: { Enabled: false },
        },
      },
    ];
  };
  const service = () => ({
    serviceName: m.service,
    desiredCount: state.stopped && !state.launched ? 0 : 1,
    runningCount: state.stopped && !state.launched ? 0 : 1,
    pendingCount: 0,
    taskDefinition: state.launched ? m.taskDefinition : m.legacyTaskDefinition,
    loadBalancers: [
      {
        targetGroupArn: m.targetGroupA,
        containerName: m.containerName,
        containerPort: m.containerPort,
      },
    ],
  });
  function scan(p) {
    if (!p.TableName.endsWith("DeploymentControlTable"))
      return {
        Count: p.TableName.endsWith("MeetingHistoryTable")
          ? state.historyCount
          : 0,
      };
    if (state.launched && p.Select !== "COUNT")
      return {
        Items: [
          marshall({
            recordType: "runtime",
            identity: runtimeIdentity,
            role: state.serving ? "serving" : "candidate",
            readiness: {
              cacheReady: true,
              dependenciesReady: true,
              gatewayReady: true,
              observedGeneration: state.serving ? 1 : 0,
              provenAt: 1000,
              expiresAt: 2000,
            },
          }),
        ],
      };
    return {
      Items: state.stage ? [marshall(state.stage)] : [],
      Count: state.stage ? 1 : 0,
    };
  }
  function getRecord(p) {
    const sk = unmarshall(p.Key).sk;
    if (sk === "CONTROL")
      return {
        Item: marshall({
          coordinatorToken: m.operationId,
          coordinatorEpoch: 1,
          coordinatorExpiresAt: 0,
          runtimeEnvironment: "ecs",
          protocolVersion: 1,
          servingGeneration: 1,
          servingMembers: { runtime: runtimeIdentity },
          pk: "ENV",
          sk,
        }),
      };
    if (sk === "BOOTSTRAP#" + m.operationId)
      return state.launched
        ? {
            Item: marshall({
              pk: "ENV",
              sk,
              operationId: m.operationId,
              manifestSha256: hash,
              stage: state.serving ? "complete" : "launched",
              candidate: runtimeIdentity,
            }),
          }
        : {};
    if (sk === "REPAIR#" + m.operationId) return {};
    return state.stage ? { Item: marshall(state.stage) } : {};
  }
  const handlers = {
    ecr: {
      "describe-images": () => ({
        imageDetails: [
          { imageDigest: m.imageDigest, imageTags: [m.sourceCommit] },
        ],
      }),
    },
    sts: {
      "get-caller-identity": () => ({ Account: account, Arn: m.principalArn }),
    },
    dynamodb: {
      "transact-write-items": (p) => {
        const put = p.TransactItems.find((x) => x.Put);
        if (!put) {
          expect(state.serving).toBe(true);
          state.stage.stage = "complete";
          return {};
        }
        if (state.stage) throw Error("exists");
        state.stage = unmarshall(put.Put.Item);
        return {};
      },
      "put-item": (p) => {
        if (state.stage) throw Error("exists");
        state.stage = unmarshall(p.Item);
        return {};
      },
      "update-item": (p) => {
        state.stage.stage = unmarshall(p.ExpressionAttributeValues)[":next"];
        return {};
      },
      "get-item": getRecord,
      scan,
    },
    ecs: {
      "describe-task-definition": () => ({
        taskDefinition: {
          taskDefinitionArn: m.taskDefinition,
          status: "ACTIVE",
          containerDefinitions: [
            {
              name: m.containerName,
              image:
                "123456789012.dkr.ecr.us-east-1.amazonaws.com/test-sandbox-repo@" +
                m.imageDigest,
              stopTimeout: 120,
              command: ["node", "dist/index.js"],
              environment: [
                { name: "TRANSCRIPTS_BUCKET", value: m.bucket },
                { name: "DDB_TABLE_PREFIX", value: m.tablePrefix },
                { name: "DEPLOYMENT_CANDIDATE_ID", value: m.operationId },
              ],
            },
          ],
        },
      }),
      "describe-services": () => ({ services: [service()], failures: [] }),
      "list-tasks": (p) => ({
        taskArns:
          p.desiredStatus === "RUNNING" && !state.stopped
            ? [ecs + "task/test-sandbox-cluster/legacy"]
            : [],
      }),
      "describe-tasks": (p) => ({
        tasks: p.tasks.map((taskArn) => ({
          taskArn,
          lastStatus: "RUNNING",
          taskDefinitionArn: m.legacyTaskDefinition,
          containers: [
            {
              name: m.containerName,
              networkInterfaces: [{ privateIpv4Address: "10.0.0.1" }],
            },
          ],
        })),
        failures: [],
      }),
      "get-task-protection": (p) => ({
        protectedTasks: [
          {
            taskArn: p.tasks[0],
            protectionEnabled: lateLegacy("protected"),
          },
        ],
        failures: [],
      }),
      "update-service": () => {
        expect(state.stage.stage).toBe("stop_submitted");
        if (state.lostStop) throw Error("ACK unknown");
        state.stopped = true;
        return { service: service() };
      },
    },
    elbv2: {
      "describe-listeners": () => ({
        Listeners: [
          {
            ListenerArn: m.listenerArn,
            LoadBalancerArn: "lb",
            Protocol: "HTTPS",
            DefaultActions: action(),
          },
        ],
      }),
      "describe-target-groups": () => ({
        TargetGroups: [m.targetGroupA, m.targetGroupB].map(
          (TargetGroupArn) => ({
            TargetGroupArn,
            TargetType: "ip",
            Protocol: "HTTP",
            Port: m.containerPort,
            HealthCheckPath: "/health",
            VpcId: "vpc",
            LoadBalancerArns: TargetGroupArn === m.targetGroupA ? ["lb"] : [],
          }),
        ),
      }),
      "describe-target-group-attributes": () => ({
        Attributes: [{ Key: "stickiness.enabled", Value: "false" }],
      }),
      "describe-rules": () => ({ Rules: [{ IsDefault: true }] }),
      "describe-target-health": (p) => ({
        TargetHealthDescriptions:
          p.TargetGroupArn === m.targetGroupA && !state.stopped
            ? [
                {
                  Target: {
                    Id: lateLegacy("target") ? "10.0.0.99" : "10.0.0.1",
                    Port: 3001,
                  },
                  TargetHealth: { State: "healthy" },
                },
              ]
            : [],
      }),
      "modify-listener": () => {
        expect(state.stage.stage).toBe("routing_submitted");
        if (state.lostRoute) throw Error("ACK unknown");
        state.routed = true;
        return {
          Listeners: [{ ListenerArn: m.listenerArn, DefaultActions: action() }],
        };
      },
    },
  };
  const aws = async (s, o, p) => {
    calls.push({ s, o, p });
    const handler = handlers[s]?.[o];
    if (!handler) throw Error("Unexpected " + s + "." + o);
    return handler(p);
  };
  const bootstrap = {
    readiness: jest.fn(async () => ({ kind: "ready" })),
    initialize: jest.fn(async () => ({ kind: "initialized" })),
    launch: jest.fn(async () => {
      state.launched = true;
      return { kind: "launched" };
    }),
    promote: jest.fn(async () => {
      state.serving = true;
      return { kind: "complete", generation: 1 };
    }),
  };
  return { m, hash, env, state, calls, aws, bootstrap };
}
function introduction(f, options = {}) {
  return createIntroduction({
    manifest: f.m,
    expectedSha256: f.hash,
    aws: f.aws,
    bootstrap: f.bootstrap,
    now: () => 1000,
    pause: async () => {},
    ...options,
  });
}

function expectNoWrites(
  f,
  operations = ["transact-write-items", "update-service", "modify-listener"],
) {
  expect(f.calls.some((call) => operations.includes(call.o))).toBe(false);
}

test.each(["protected", "target"])(
  "activation revalidates late legacy %s before stopping",
  async (kind) => {
    const f = fixture();
    f.state.lateLegacy = kind;
    await expect(introduction(f).activate()).rejects.toThrow();
    expect(f.calls.filter((c) => c.o === "update-service")).toHaveLength(0);
    expect(f.state.stage.stage).toBe("stop_submitted");
  },
);

test("binds the reviewed operation session before execution", () => {
  const f = fixture();
  expect(bindJob(f.env).sessionName).toBe(f.m.principalArn.split("/").at(-1));
});
test.each([
  "GITHUB_SHA",
  "EXPECTED_ACCOUNT_ID",
  "EXPECTED_ROLE_ARN",
  "GITHUB_RUN_ATTEMPT",
])("rejects a foreign %s before binding", (key) => {
  const f = fixture();
  f.env[key] = key === "GITHUB_RUN_ATTEMPT" ? "2" : "foreign";
  expect(() => bindJob(f.env)).toThrow();
});
test("records intent before stop and routing and reuses guarded bootstrap", async () => {
  const f = fixture();
  await expect(introduction(f).activate()).resolves.toEqual({
    kind: "complete",
    generation: 1,
  });
  expect(f.bootstrap.initialize).toHaveBeenCalledTimes(1);
  expect(f.bootstrap.launch).toHaveBeenCalledTimes(1);
  expect(f.bootstrap.promote).toHaveBeenCalledTimes(1);
  expect(f.state.stage.stage).toBe("complete");
  expectNoWrites(f, ["stop-task", "update-task-protection", "delete-item"]);
});
test.each(["lostStop", "lostRoute"])(
  "does not replay an unknown provider write: %s",
  async (flag) => {
    const f = fixture();
    f.state[flag] = true;
    const intro = introduction(f);
    await expect(intro.activate()).rejects.toThrow();
    await expect(intro.activate()).rejects.toThrow();
    expect(f.calls.filter((c) => c.o === "update-service")).toHaveLength(1);
    expect(f.bootstrap.initialize).not.toHaveBeenCalled();
  },
);
test("unsettled history blocks every provider write", async () => {
  const f = fixture();
  f.state.historyCount = 1;
  await expect(introduction(f).activate()).rejects.toThrow();
  expectNoWrites(f, ["put-item", "update-service", "modify-listener"]);
});
test("an invalid prepared candidate refuses before stopping legacy", async () => {
  const f = fixture();
  const aws = async (s, o, p) =>
    s === "ecs" && o === "describe-task-definition"
      ? { taskDefinition: { status: "INACTIVE" } }
      : f.aws(s, o, p);
  await expect(
    introduction(f, {
      aws,
    }).activate(),
  ).rejects.toThrow();
  expectNoWrites(f);
});
test("activation requires the manifest operation to match the requested session", () => {
  const f = fixture();
  f.env.BOOTSTRAP_OPERATION_ID = randomUUID();
  expect(() => bindJob(f.env)).toThrow();
});
test("the existing identity workflow keeps its default read-only and gates bootstrap", () => {
  const workflow = parse(
    readFileSync(".github/workflows/sandbox-identity.yml", "utf8"),
  );
  expect(workflow.on.workflow_dispatch.inputs.bootstrap_phase.default).toBe(
    "none",
  );
  expect(workflow.jobs.bootstrap.environment).toBe("sandbox");
  expect(workflow.jobs.bootstrap.needs).toBe("identity");
  expect(workflow.jobs.bootstrap.if).toContain("!= 'none'");
  expect(
    workflow.jobs.bootstrap.steps.some((s) =>
      s.run?.includes("introduce-sandbox.cjs"),
    ),
  ).toBe(true);
  expect(workflow.jobs["denial-probe"].environment).toBeUndefined();
  expect(
    workflow.jobs["denial-probe"].steps.some(
      (s) => s.with?.["inline-session-policy"],
    ),
  ).toBe(true);
});

test("binding preserves the reviewed manifest serialization for its checksum", () => {
  const f = fixture();
  expect(
    createHash("sha256")
      .update(JSON.stringify(bindJob(f.env).manifest))
      .digest("hex"),
  ).toBe(f.hash);
});

function preparation() {
  const f = fixture(),
    family = "test-sandbox-task";
  const env = {
    ...f.env,
    BOOTSTRAP_PHASE: "prepare",
    AWS_REGION: "us-east-1",
    ECS_CLUSTER: f.m.cluster,
    ECS_SERVICE: f.m.service,
    ECS_TASK_FAMILY: family,
    SECRETS_PREFIX: "test-sandbox",
    CANDIDATE_IMAGE:
      "123456789012.dkr.ecr.us-east-1.amazonaws.com/test-sandbox-repo@" +
      f.m.imageDigest,
  };
  const definition = {
    family,
    status: "ACTIVE",
    taskDefinitionArn: f.m.taskDefinition,
    taskRoleArn:
      "arn:aws:iam::123456789012:role/test-sandbox-ecs-task-app-role",
    executionRoleArn:
      "arn:aws:iam::123456789012:role/test-sandbox-ecs-task-exec-role",
    containerDefinitions: [
      {
        name: f.m.containerName,
        image: "legacy",
        command: ["npx", "yarn", "serve"],
        environment: [
          { name: "DDB_TABLE_PREFIX", value: f.m.tablePrefix },
          { name: "TRANSCRIPTS_BUCKET", value: f.m.bucket },
        ],
        secrets: [
          {
            name: "OPENAI_API_KEY",
            valueFrom:
              "arn:aws:secretsmanager:us-east-1:123456789012:secret:test-sandbox/openai-abcdef",
          },
        ],
      },
    ],
  };
  const state = {
    root: false,
    foreignDigest: false,
    unknownRegistration: false,
    candidate: null,
    registrations: 0,
  };
  const aws = async (s, o, p) => {
    if (s === "sts")
      return {
        Account: f.m.accountId,
        Arn: state.root
          ? "arn:aws:iam::123456789012:root"
          : "arn:aws:sts::123456789012:assumed-role/test-sandbox-github-deploy/chronote-sandbox-12-1",
      };
    if (s === "ecr")
      return {
        imageDetails: [
          {
            imageDigest: state.foreignDigest
              ? "sha256:" + "d".repeat(64)
              : f.m.imageDigest,
            imageTags: [f.m.sourceCommit],
          },
        ],
      };
    if (o === "list-task-definitions")
      return { taskDefinitionArns: state.candidate ? ["candidate"] : [] };
    if (o === "describe-task-definition")
      return {
        taskDefinition:
          p.taskDefinition === "candidate" ? state.candidate : definition,
      };
    if (o === "register-task-definition") {
      state.registrations++;
      state.candidate = {
        ...p,
        status: "ACTIVE",
        taskDefinitionArn: "candidate",
      };
      if (state.unknownRegistration) throw Error("lost");
      return { taskDefinition: state.candidate };
    }
    throw Error("Unexpected preparation call");
  };
  return { f, env, state, aws };
}
test("preparation registers a pinned source and explicit Node launcher", async () => {
  const p = preparation();
  await expect(prepare(p.env, p.aws)).resolves.toEqual({ kind: "prepared" });
  expect(p.state.candidate.containerDefinitions[0]).toMatchObject({
    image: p.env.CANDIDATE_IMAGE,
    command: ["node", "dist/index.js"],
    stopTimeout: 120,
  });
});
test.each(["root", "foreignDigest"])(
  "preparation refuses %s without registration",
  async (flag) => {
    const p = preparation();
    p.state[flag] = true;
    await expect(prepare(p.env, p.aws)).rejects.toThrow();
    expect(p.state.registrations).toBe(0);
  },
);
test("unknown registration cannot be duplicated by a second preparation", async () => {
  const p = preparation();
  p.state.unknownRegistration = true;
  await expect(prepare(p.env, p.aws)).rejects.toThrow();
  await expect(prepare(p.env, p.aws)).rejects.toThrow();
  expect(p.state.registrations).toBe(1);
});

test("accepts AWS's legacy TargetGroupArn-only forward action", async () => {
  const f = fixture();
  const aws = async (service, operation, input) => {
    const response = await f.aws(service, operation, input);
    if (
      service === "elbv2" &&
      operation === "describe-listeners" &&
      !f.state.routed
    )
      delete response.Listeners[0].DefaultActions[0].ForwardConfig;
    return response;
  };
  await expect(
    introduction(f, {
      aws,
    }).activate(),
  ).resolves.toEqual({ kind: "complete", generation: 1 });
});

test.each(["foreign-source", "drifted-group"])(
  "refuses %s before reserving or stopping",
  async (kind) => {
    const f = fixture();
    const aws = async (service, operation, input) => {
      if (
        kind === "foreign-source" &&
        service === "ecr" &&
        operation === "describe-images"
      )
        return {
          imageDetails: [
            {
              imageDigest: "sha256:" + "c".repeat(64),
              imageTags: [f.m.sourceCommit],
            },
          ],
        };
      if (
        service === "elbv2" &&
        operation === "describe-target-groups" &&
        kind === "drifted-group"
      )
        return { TargetGroups: [] };
      return f.aws(service, operation, input);
    };
    await expect(
      introduction(f, {
        aws,
      }).activate(),
    ).rejects.toThrow();
    expectNoWrites(f);
  },
);

test("polls read-only promotion readiness before submitting promotion once", async () => {
  const f = fixture();
  f.bootstrap.readiness = jest
    .fn()
    .mockResolvedValueOnce({ kind: "waiting" })
    .mockResolvedValue({ kind: "ready" });
  f.bootstrap.promote.mockImplementation(async () => {
    expect(f.bootstrap.readiness).toHaveBeenCalledTimes(2);
    f.state.serving = true;
    return { kind: "complete", generation: 1 };
  });
  await expect(introduction(f).activate()).resolves.toEqual({
    kind: "complete",
    generation: 1,
  });
  expect(f.bootstrap.promote).toHaveBeenCalledTimes(1);
});

test("ignores a replaced candidate row when confirming the promoted member", async () => {
  const f = fixture();
  const aws = async (service, operation, input) => {
    const response = await f.aws(service, operation, input);
    if (
      service === "dynamodb" &&
      operation === "scan" &&
      input.Select !== "COUNT" &&
      f.state.launched
    )
      response.Items.push(
        marshall({
          recordType: "runtime",
          identity: { candidateId: f.m.operationId, taskArn: "replaced" },
          role: "candidate",
          readiness: { expiresAt: 900 },
        }),
      );
    return response;
  };
  await expect(
    introduction(f, {
      aws,
    }).activate(),
  ).resolves.toEqual({ kind: "complete", generation: 1 });
});

test("does not promote when a read-only readiness check exceeds its warmup deadline", async () => {
  const f = fixture();
  let time = 1000;
  f.bootstrap.readiness = jest.fn(async () => {
    time = 1901;
    return { kind: "ready" };
  });
  await expect(
    introduction(f, {
      now: () => time,
    }).activate(),
  ).rejects.toThrow();
  expect(f.bootstrap.promote).not.toHaveBeenCalled();
});

test.each([
  "foreign-target",
  "protected-legacy",
  "aging-proof",
  "slow-preflight",
])("refuses %s without reserving or stopping", async (kind) => {
  const f = fixture();
  let time = kind === "aging-proof" ? 1500 : 1000;
  const aws = async (service, operation, input) => {
    const response = await f.aws(service, operation, input);
    if (
      kind === "foreign-target" &&
      service === "elbv2" &&
      operation === "describe-target-health" &&
      input.TargetGroupArn === f.m.targetGroupA &&
      !f.state.stopped
    )
      response.TargetHealthDescriptions.push({
        Target: { Id: "foreign", Port: 3001 },
        TargetHealth: { State: "healthy" },
      });
    if (
      kind === "protected-legacy" &&
      service === "ecs" &&
      operation === "get-task-protection"
    )
      response.protectedTasks[0].protectionEnabled = true;
    if (kind === "slow-preflight" && operation === "get-task-protection")
      time = 1400;
    return response;
  };
  await expect(
    introduction(f, {
      aws,
      now: () => time,
    }).activate(),
  ).rejects.toThrow();
  expectNoWrites(f);
});

test("resumes read-only readiness after a pre-write promotion race", async () => {
  const f = fixture();
  const finish = f.bootstrap.promote.getMockImplementation();
  f.bootstrap.promote
    .mockImplementationOnce(async () => {
      throw Object.assign(new Error("candidate replaced"), {
        code: "candidate_not_ready",
      });
    })
    .mockImplementation(finish);
  await expect(introduction(f).activate()).resolves.toEqual({
    kind: "complete",
    generation: 1,
  });
  expect(f.bootstrap.readiness).toHaveBeenCalledTimes(2);
  expect(f.bootstrap.promote).toHaveBeenCalledTimes(2);
});

test("never retries an unknown promotion write outcome", async () => {
  const f = fixture();
  f.bootstrap.promote.mockRejectedValue(new Error("write outcome unknown"));
  const intro = introduction(f);
  await expect(intro.activate()).rejects.toThrow();
  await expect(intro.activate()).rejects.toThrow();
  expect(f.bootstrap.promote).toHaveBeenCalledTimes(1);
});

test("repair binds the old and new manifests under one reviewed envelope checksum", () => {
  const f = fixture();
  const next = structuredClone(f.m);
  next.operationId = randomUUID();
  next.sourceCommit = "d".repeat(40);
  next.legacyTaskDefinition = f.m.taskDefinition;
  next.taskDefinition = f.m.taskDefinition.replace(/:2$/, ":3");
  next.imageDigest = "sha256:" + "e".repeat(64);
  next.principalArn = f.m.principalArn.replace(
    /chronote-sandbox-\d+-1$/,
    "chronote-sandbox-" +
      BigInt("0x" + next.operationId.replaceAll("-", "")) +
      "-1",
  );
  const payload = { manifest: next, previousManifest: f.m };
  const checksum = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  const env = {
    ...f.env,
    BOOTSTRAP_PHASE: "repair",
    BOOTSTRAP_MANIFEST_JSON: JSON.stringify(payload),
    BOOTSTRAP_MANIFEST_SHA256: checksum,
    BOOTSTRAP_OPERATION_ID: next.operationId,
    GITHUB_SHA: next.sourceCommit,
  };
  expect(bindJob(env)).toMatchObject({
    manifest: next,
    previousManifest: f.m,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(next))
      .digest("hex"),
    previousManifestSha256: f.hash,
  });
  payload.previousManifest.sourceCommit = "f".repeat(40);
  expect(() =>
    bindJob({ ...env, BOOTSTRAP_MANIFEST_JSON: JSON.stringify(payload) }),
  ).toThrow();
});
