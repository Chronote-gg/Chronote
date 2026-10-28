/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  cutoverConfig,
  runCli,
  verifyApproval,
} from "../../scripts/deployment/cold-cutover.cjs";
import { createBootstrap } from "../../scripts/deployment/bootstrap-sandbox.cjs";
import {
  nativeEnvironment,
  nativeBranchPolicies,
} from "../fixtures/deployment/terraformWorkflow.js";

const account = "123456789012";
const region = "us-east-1";
const prefix = "meeting-notes-prod-";
const family = "meeting-notes-prod-bot-task";
const ecs = `arn:aws:ecs:${region}:${account}:`;
const elb = `arn:aws:elasticloadbalancing:${region}:${account}:`;
const groupA = elb + "targetgroup/meeting-notes-prod-api-tg/1";
const groupB = elb + "targetgroup/meeting-notes-prod-api-spare/2";
const listenerArn = elb + "listener/app/meeting-notes-prod-api/1/2";
const legacyArn = ecs + `task-definition/${family}:239`;
const image = `${account}.dkr.ecr.${region}.amazonaws.com/meeting-notes-prod@sha256:${"b".repeat(64)}`;
const MUTATIONS = [
  "register-task-definition",
  "update-service",
  "modify-listener",
  "put-item",
  "update-item",
  "transact-write-items",
];

function environment(overrides = {}) {
  return {
    CUTOVER_ENVIRONMENT: "production",
    CUTOVER_OPERATION_ID: randomUUID(),
    EXPECTED_ACCOUNT_ID: account,
    AWS_REGION: region,
    EXPECTED_ROLE_ARN: `arn:aws:iam::${account}:role/meeting-notes-prod-github-deploy`,
    EXPECTED_SESSION_NAME: "chronote-production-42-1",
    ECS_CLUSTER: "meeting-notes-prod-bot-cluster",
    ECS_SERVICE: "meeting-notes-prod-bot-service",
    ECS_TASK_FAMILY: family,
    SECRETS_PREFIX: "meeting-notes-prod",
    DEPLOYMENT_LISTENER_ARN: listenerArn,
    DEPLOYMENT_TARGET_GROUP_A: groupA,
    DEPLOYMENT_TARGET_GROUP_B: groupB,
    CANDIDATE_IMAGE: image,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "42",
    GITHUB_SHA: "a".repeat(40),
    ...overrides,
  };
}

function legacyDefinition() {
  return {
    taskDefinitionArn: legacyArn,
    family,
    revision: 239,
    status: "ACTIVE",
    taskRoleArn: `arn:aws:iam::${account}:role/meeting-notes-prod-ecs-task-app-role`,
    containerDefinitions: [
      {
        name: "meeting-notes-prod-bot",
        image: `${account}.dkr.ecr.${region}.amazonaws.com/meeting-notes-prod:old`,
        command: ["npx", "yarn", "serve"],
        environment: [
          { name: "DDB_TABLE_PREFIX", value: prefix },
          {
            name: "TRANSCRIPTS_BUCKET",
            value: "meeting-notes-prod-transcripts",
          },
        ],
        secrets: [],
      },
    ],
  };
}

// JSON round trips keep fake responses in the module's realm, like real CLI output.
const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const isRunning = (state) => state.svc.runningCount > 0;
function definitionFor(state, name) {
  return name === family
    ? state.definitions.at(-1)
    : state.definitions.find((d) => d.taskDefinitionArn === name);
}
function registerDefinition(state, input) {
  const revision = 239 + state.definitions.length;
  const registered = {
    ...clone(input),
    taskDefinitionArn: ecs + `task-definition/${family}:${revision}`,
    revision,
    status: "ACTIVE",
  };
  state.registered = registered;
  state.definitions.push(registered);
  return { taskDefinition: registered };
}
function scanTable(state, input) {
  const name = input.TableName.slice(prefix.length);
  if (name === "MeetingHistoryTable") return { Count: state.history };
  if (name !== "DeploymentControlTable")
    return { Items: state.work[name].map((v) => marshall(v)) };
  if (input.Select === "COUNT") return { Count: state.control.size };
  return { Items: [...state.control.values()].map((v) => marshall(v)) };
}
/** One small handler per AWS CLI operation the cutover issues. */
const AWS_HANDLERS = {
  "get-caller-identity": (state, input, { env }) => ({
    Account: account,
    Arn: `arn:aws:sts::${account}:assumed-role/meeting-notes-prod-github-deploy/${env.EXPECTED_SESSION_NAME}`,
  }),
  "describe-services": (state) => ({
    failures: [],
    services: [clone(state.svc)],
  }),
  "list-tasks": (state, input) => ({
    taskArns:
      isRunning(state) && input.desiredStatus === "RUNNING"
        ? ["legacy-task"]
        : [],
  }),
  "describe-tasks": (state, input) => ({
    failures: [],
    tasks: input.tasks.map((taskArn) => ({ taskArn, lastStatus: "RUNNING" })),
  }),
  "describe-target-health": (state, input) => ({
    TargetHealthDescriptions:
      input.TargetGroupArn === groupA && isRunning(state)
        ? [{ Target: { Id: "10.0.0.1", Port: 3001 } }]
        : [],
  }),
  "describe-listeners": (state) => ({
    Listeners: [
      {
        ListenerArn: listenerArn,
        Protocol: "HTTPS",
        DefaultActions: clone(state.listener),
      },
    ],
  }),
  "describe-rules": () => ({ Rules: [{ IsDefault: true }] }),
  "modify-listener": (state, input) => {
    state.listener = input.DefaultActions;
    return { Listeners: [{ DefaultActions: input.DefaultActions }] };
  },
  "list-task-definitions": (state) => ({
    taskDefinitionArns: state.definitions
      .map((d) => d.taskDefinitionArn)
      .reverse(),
  }),
  "describe-task-definition": (state, input) => ({
    taskDefinition: clone(definitionFor(state, input.taskDefinition)),
  }),
  "register-task-definition": registerDefinition,
  "update-service": (state, input, { onStop }) => {
    Object.assign(state.svc, { desiredCount: 0, runningCount: 0 });
    onStop(state);
    return { service: clone(state.svc) };
  },
  "get-item": (state, input) => {
    const row = state.control.get(unmarshall(input.Key).sk);
    return row ? { Item: marshall(row) } : {};
  },
  scan: scanTable,
};

/** Stateful AWS fake: one legacy task behind group A until the service is stopped. */
function fakeAws(env, { work = {}, onStop = () => {}, fail } = {}) {
  const state = {
    calls: [],
    svc: {
      serviceName: env.ECS_SERVICE,
      desiredCount: 1,
      runningCount: 1,
      pendingCount: 0,
      taskDefinition: legacyArn,
      loadBalancers: [
        {
          targetGroupArn: groupA,
          containerName: "meeting-notes-prod-bot",
          containerPort: 3001,
        },
      ],
    },
    definitions: [legacyDefinition()],
    work: {
      MeetingControlCommandTable: [],
      PersonalMediaUploadJobTable: [],
      PersonalRecordingSegmentTable: [],
      ActiveMeetingTable: [],
      ...work,
    },
    history: 10,
    control: new Map(),
    listener: [
      {
        Type: "forward",
        TargetGroupArn: groupA,
        ForwardConfig: {
          TargetGroups: [{ TargetGroupArn: groupA, Weight: 1 }],
          TargetGroupStickinessConfig: { Enabled: false },
        },
      },
    ],
  };
  state.aws = async (service, operation, input) => {
    state.calls.push(operation);
    if (fail?.(operation, input)) throw new Error("provider failure");
    const handler = AWS_HANDLERS[operation];
    if (!handler) throw new Error("Unexpected AWS call " + operation);
    return handler(state, input, { env, onStop });
  };
  return state;
}

/** Bootstrap stand-in that records phases and produces the promoted Control end state. */
function fakeBootstrap(state, env) {
  return (options) => {
    state.bootstrapOptions = options;
    const candidate = {
      kind: "ecs",
      instanceId: "candidate",
      candidateId: env.CUTOVER_OPERATION_ID,
    };
    return {
      initialize: async () => {
        state.calls.push("bootstrap.initialize");
        const key = "BOOTSTRAP#" + env.CUTOVER_OPERATION_ID;
        if (!state.control.has(key))
          state.control.set(key, {
            sk: key,
            stage: "initialized",
            ...options.receiptFields,
          });
      },
      launch: async () => {
        state.calls.push("bootstrap.launch");
        Object.assign(state.svc, {
          desiredCount: 1,
          runningCount: 1,
          taskDefinition: options.binding.taskDefinition,
        });
      },
      readiness: async () => ({ kind: "ready" }),
      promote: async () => {
        state.calls.push("bootstrap.promote");
        state.control.set("CONTROL", {
          sk: "CONTROL",
          servingGeneration: 1,
          coordinatorExpiresAt: 0,
          servingMembers: { candidate },
        });
        state.control.set("RUNTIME#candidate", {
          sk: "RUNTIME#candidate",
          recordType: "runtime",
          identity: candidate,
          role: "serving",
          readiness: { observedGeneration: 1, provenAt: 1, expiresAt: 4e9 },
        });
        state.control.get("BOOTSTRAP#" + env.CUTOVER_OPERATION_ID).stage =
          "complete";
      },
    };
  };
}

async function run(mode, env, state, approval = async () => {}) {
  const lines = [];
  const output = {
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  const code = await runCli(mode, env, {
    aws: state.aws,
    output,
    sleep: async () => {},
    bootstrapFactory: fakeBootstrap(state, env),
    verifyApproval: async () => {
      state.calls.push("approval");
      await approval();
    },
  });
  return { code, lines, text: lines.join("\n") };
}
const index = (state, call) => state.calls.indexOf(call);

test("cuts over in order: approval, candidate, pre-stop check, stop, recheck, routing, bootstrap", async () => {
  const env = environment();
  const state = fakeAws(env);
  const result = await run("cutover", env, state);
  expect(result.code).toBe(0);
  const order = [
    "approval",
    "register-task-definition",
    "update-service",
    "modify-listener",
    "bootstrap.initialize",
    "bootstrap.launch",
    "bootstrap.promote",
  ].map((call) => index(state, call));
  expect(order.every((v) => v >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  const scans = state.calls
    .map((call, i) => (call === "scan" ? i : -1))
    .filter((i) => i >= 0);
  expect(scans.some((i) => i < index(state, "update-service"))).toBe(true);
  expect(
    scans.some(
      (i) =>
        i > index(state, "update-service") &&
        i < index(state, "modify-listener"),
    ),
  ).toBe(true);
  const container = state.registered.containerDefinitions[0];
  expect(container.command).toEqual(["node", "dist/index.js"]);
  expect(container.stopTimeout).toBe(120);
  expect(container.image).toBe(image);
  for (const flag of [
    "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
    "STRIPE_RENEWAL_GRACE_ENABLED",
    "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
    "STRIPE_RENEWAL_REACTIVATION_ENABLED",
  ])
    expect(container.environment).toContainEqual({
      name: flag,
      value: "false",
    });
  expect(container.environment).toContainEqual({
    name: "DEPLOYMENT_CANDIDATE_ID",
    value: env.CUTOVER_OPERATION_ID,
  });
  expect(state.bootstrapOptions.binding).toMatchObject({
    legacyTaskDefinition: legacyArn,
    targetGroupA: groupA,
    targetGroupB: groupB,
    bucket: "meeting-notes-prod-transcripts",
  });
  expect(state.control.has("INTRODUCTION")).toBe(false);
  expect(result.text).toContain('"incident":false');
});

test.each([
  ["ActiveMeetingTable", { guildId: "guild-a" }],
  ["MeetingControlCommandTable", { queueStatus: "pending", expiresAt: 4e9 }],
  ["MeetingControlCommandTable", { queueStatus: "pending" }],
  ["PersonalMediaUploadJobTable", { status: "queued" }],
  ["PersonalMediaUploadJobTable", { status: "processing" }],
  ["PersonalMediaUploadJobTable", { status: "pending_upload" }],
  ["PersonalRecordingSegmentTable", { status: "uploaded" }],
  ["PersonalRecordingSegmentTable", {}],
])(
  "in-flight %s row %o defers without touching the service",
  async (table, row) => {
    const env = environment();
    const state = fakeAws(env, { work: { [table]: [row] } });
    const result = await run("cutover", env, state);
    expect(result.code).toBe(0);
    expect(result.text).toContain("Cutover deferred");
    for (const call of [
      "update-service",
      "modify-listener",
      "bootstrap.initialize",
    ])
      expect(state.calls).not.toContain(call);
  },
);

test("terminal rows and expired commands do not block", async () => {
  const env = environment();
  const state = fakeAws(env, {
    work: {
      MeetingControlCommandTable: [
        { queueStatus: "completed" },
        { queueStatus: "pending", expiresAt: 1 },
      ],
      PersonalMediaUploadJobTable: [
        { status: "complete" },
        { status: "failed" },
      ],
      PersonalRecordingSegmentTable: [{ status: "processed" }],
    },
  });
  expect((await run("cutover", env, state)).code).toBe(0);
  expect(state.calls).toContain("bootstrap.promote");
});

test.each([
  [
    "claimed with a live claim past the queue TTL",
    {
      queueStatus: "pending",
      expiresAt: 1,
      claimedByInstanceId: "worker",
      claimExpiresAt: 4e9,
    },
    true,
  ],
  [
    "claimed with an expired claim past the queue TTL",
    {
      queueStatus: "pending",
      expiresAt: 1,
      claimedByInstanceId: "worker",
      claimExpiresAt: 2,
    },
    true,
  ],
  [
    "unclaimed past the queue TTL",
    { queueStatus: "pending", expiresAt: 1 },
    false,
  ],
])("a meeting control command %s blocks: %s", async (_, row, blocks) => {
  const env = environment();
  const state = fakeAws(env, { work: { MeetingControlCommandTable: [row] } });
  const result = await run("cutover", env, state);
  expect(result.code).toBe(0);
  expect(result.text.includes("Cutover deferred")).toBe(blocks);
  expect(state.calls.includes("update-service")).toBe(!blocks);
});

test("an unknown work answer refuses before stopping", async () => {
  const env = environment();
  const state = fakeAws(env, {
    fail: (operation, input) =>
      operation === "scan" && input.TableName.endsWith("ActiveMeetingTable"),
  });
  const result = await run("cutover", env, state);
  expect(result.code).toBe(1);
  expect(state.calls).not.toContain("update-service");
});

test.each([
  [
    "a lease left behind",
    (state) => state.work.ActiveMeetingTable.push({ guildId: "guild-b" }),
  ],
  ["a meeting that started and finished", (state) => (state.history += 1)],
])(
  "post-stop recheck reports %s loudly but still restores service",
  async (_, race) => {
    const env = environment();
    const state = fakeAws(env, { onStop: race });
    const result = await run("cutover", env, state);
    expect(result.code).toBe(2);
    expect(result.text).toContain(
      "::error title=Work appeared during the stop window",
    );
    expect(result.text).toContain('"incident":true');
    expect(state.calls).toContain("bootstrap.promote");
    expect(state.calls).not.toContain("delete-item");
  },
);

test("unverified approval refuses before any provider call", async () => {
  const env = environment();
  const state = fakeAws(env);
  const result = await run("cutover", env, state, async () => {
    throw new Error("no approval");
  });
  expect(result.code).toBe(1);
  expect(result.text).toContain("Native approval");
  expect(state.calls).toEqual(["approval"]);
});

test("refuses existing Control ownership and foreign listener routing before stopping", async () => {
  const env = environment();
  const owned = fakeAws(env);
  owned.control.set("CONTROL", { sk: "CONTROL" });
  expect((await run("cutover", env, owned)).code).toBe(1);
  const foreign = fakeAws(env);
  foreign.listener = [{ Type: "fixed-response" }];
  expect((await run("cutover", env, foreign)).code).toBe(1);
  for (const state of [owned, foreign])
    expect(state.calls).not.toContain("update-service");
});

test("refuses enabled financial flags before registering a candidate", async () => {
  const env = environment();
  const state = fakeAws(env);
  state.definitions[0].containerDefinitions[0].environment.push({
    name: "STRIPE_RENEWAL_GRACE_ENABLED",
    value: "true",
  });
  expect((await run("cutover", env, state)).code).toBe(1);
  expect(state.calls).not.toContain("register-task-definition");
});

/** Replays the first run's AWS state with the receipt left at `initialized`. */
async function resumedAfterInitialize(env, receipt) {
  const first = fakeAws(env);
  await run("cutover", env, first);
  const resumed = fakeAws(env);
  resumed.definitions = first.definitions;
  resumed.svc = first.svc;
  resumed.listener = first.listener;
  const key = "BOOTSTRAP#" + env.CUTOVER_OPERATION_ID;
  resumed.control.set(key, receipt(first.control.get(key)));
  return { resumed, result: await run("cutover", env, resumed) };
}

test("resumes an initialized operation without a second stop or registration", async () => {
  const env = environment();
  const { resumed, result } = await resumedAfterInitialize(env, (stored) => ({
    ...stored,
    stage: "initialized",
  }));
  expect(result.code).toBe(0);
  expect(result.text).toContain('"incident":false');
  expect(resumed.calls).not.toContain("update-service");
  expect(resumed.calls).not.toContain("register-task-definition");
  expect(resumed.calls).toContain("bootstrap.promote");
});

test.each([
  [
    "a recorded stop-window incident",
    (stored) => ({
      ...stored,
      stage: "initialized",
      cutoverRecheck: { ...stored.cutoverRecheck, incident: true },
    }),
  ],
  [
    "a receipt without the recorded recheck",
    (stored) => ({ sk: stored.sk, stage: "initialized" }),
  ],
])("resume reports %s as an incident", async (_, receipt) => {
  const env = environment();
  const { result } = await resumedAfterInitialize(env, receipt);
  expect(result.code).toBe(2);
  expect(result.text).toContain('"incident":true');
});

test("the post-stop recheck is stored with the operation receipt", async () => {
  const env = environment();
  const state = fakeAws(env, {
    onStop: (s) => s.work.ActiveMeetingTable.push({ guildId: "guild-c" }),
  });
  await run("cutover", env, state);
  expect(
    state.control.get("BOOTSTRAP#" + env.CUTOVER_OPERATION_ID).cutoverRecheck,
  ).toMatchObject({
    incident: true,
    before: { ActiveMeetingTable: 0 },
    after: { ActiveMeetingTable: 1 },
  });
});

test("inspection is read-only and reports readiness", async () => {
  const env = environment({ CUTOVER_OPERATION_ID: "", CANDIDATE_IMAGE: "" });
  const state = fakeAws(env, {
    work: { PersonalMediaUploadJobTable: [{ status: "queued" }] },
  });
  const result = await run("inspect", env, state);
  expect(result.code).toBe(0);
  expect(state.calls.filter((call) => MUTATIONS.includes(call))).toEqual([]);
  expect(state.calls).not.toContain("approval");
  const report = JSON.parse(result.lines[0]);
  expect(report).toMatchObject({
    listener: "legacy",
    readyForCutover: false,
    work: { PersonalMediaUploadJobTable: 1, ActiveMeetingTable: 0 },
    service: { desired: 1, revision: 239 },
  });
});

test("configuration cannot mix production and Sandbox names", () => {
  expect(() => cutoverConfig(environment(), "cutover")).not.toThrow();
  expect(() =>
    cutoverConfig(
      environment({ ECS_CLUSTER: "chronote-sandbox-cluster" }),
      "inspect",
    ),
  ).toThrow();
  expect(() =>
    cutoverConfig(environment({ CUTOVER_ENVIRONMENT: "sandbox" }), "inspect"),
  ).toThrow();
  expect(() =>
    cutoverConfig(environment({ CUTOVER_OPERATION_ID: "" }), "cutover"),
  ).toThrow();
});

test("bootstrap accepts a caller binding and its own settled-work attestation", async () => {
  const binding = {
    region,
    accountId: account,
    principalArn: "arn:aws:sts::" + account + ":assumed-role/r/s",
    operationId: randomUUID(),
    tablePrefix: prefix,
    cluster: "meeting-notes-prod-bot-cluster",
    service: "meeting-notes-prod-bot-service",
    containerName: "meeting-notes-prod-bot",
    containerPort: 3001,
    targetGroupA: groupA,
    legacyTaskDefinition: legacyArn,
  };
  const aws = async (_, operation) =>
    ({
      "get-caller-identity": { Account: account, Arn: binding.principalArn },
      "get-item": {},
      "describe-services": {
        services: [
          {
            serviceName: binding.service,
            desiredCount: 0,
            runningCount: 0,
            pendingCount: 0,
            taskDefinition: legacyArn,
            loadBalancers: [
              {
                targetGroupArn: groupA,
                containerName: binding.containerName,
                containerPort: 3001,
              },
            ],
          },
        ],
      },
      "list-tasks": { taskArns: [] },
    })[operation];
  const boot = createBootstrap({
    binding,
    expectedSha256: "c".repeat(64),
    aws,
    builders: {},
    types: {},
    attestSettled: async () => {
      throw new Error("attested by caller");
    },
  });
  await expect(boot.initialize()).rejects.toThrow("attested by caller");
});

test("approval wiring requires BASIC's native approval of this exact cutover run", async () => {
  const env = environment();
  const data = {
    run: {
      id: 42,
      repository: {
        full_name: "Chronote-gg/Chronote",
        id: 849540249,
        owner: { id: 251985640 },
      },
      head_repository: { id: 849540249 },
      head_sha: env.GITHUB_SHA,
      head_branch: "master",
      path: ".github/workflows/production-cutover.yml",
      event: "workflow_dispatch",
      run_attempt: 1,
      status: "in_progress",
      conclusion: null,
      created_at: "2026-10-20T10:00:00Z",
      actor: { id: 2165323 },
      triggering_actor: { id: 2165323 },
    },
    environment: nativeEnvironment(),
    reviews: [
      {
        state: "approved",
        user: { id: 2165323, type: "User" },
        environments: [{ id: 7, name: "production" }],
      },
    ],
  };
  data.environment.protection_rules[0].prevent_self_review = false;
  data.environment.protection_rules[0].reviewers[0].reviewer.id = 2165323;
  const get = async (path) => {
    if (path.endsWith("/approvals")) return data.reviews;
    if (path.includes("deployment-branch-policies"))
      return nativeBranchPolicies();
    if (path.endsWith("deployment_protection_rules"))
      return { total_count: 0, custom_deployment_protection_rules: [] };
    return path.includes("/environments/") ? data.environment : data.run;
  };
  await expect(verifyApproval(env, get)).resolves.toBeUndefined();
  data.run.path = ".github/workflows/verify-production-bootstrap.yml";
  await expect(verifyApproval(env, get)).rejects.toThrow();
  data.run.path = ".github/workflows/production-cutover.yml";
  data.reviews[0].user.id = 99;
  await expect(verifyApproval(env, get)).rejects.toThrow();
});

test("workflow is master-only, single-attempt, serialized with deploys and read-only for inspection", () => {
  const workflow = parse(
    readFileSync(".github/workflows/production-cutover.yml", "utf8"),
  );
  const job = workflow.jobs.cutover;
  expect(Object.keys(workflow.jobs)).toEqual(["cutover"]);
  expect(job.if).toBe(
    "github.ref == 'refs/heads/master' && github.run_attempt == 1",
  );
  expect(job.environment).toBe("${{ inputs.environment }}");
  expect(workflow.concurrency).toEqual({
    group: "chronote-deploy-${{ inputs.environment }}",
    "cancel-in-progress": false,
  });
  const sessions = job.steps.filter((s) =>
    s.uses?.startsWith("aws-actions/configure-aws-credentials@"),
  );
  expect(sessions.map((s) => s.if)).toEqual([
    "inputs.mode == 'inspect'",
    "inputs.mode == 'cutover'",
  ]);
  const policy = JSON.parse(sessions[0].with["inline-session-policy"]);
  expect(
    policy.Statement[0].Action.every((a) =>
      /:(Get|Describe|List|Scan)/.test(a),
    ),
  ).toBe(true);
  const commands = job.steps.filter((s) => s.run?.includes("cold-cutover.cjs"));
  expect(commands.map((s) => [s.if, s.run])).toEqual([
    [
      "inputs.mode == 'inspect'",
      "node scripts/deployment/cold-cutover.cjs inspect",
    ],
    [
      "inputs.mode == 'cutover'",
      "node scripts/deployment/cold-cutover.cjs cutover",
    ],
  ]);
});
