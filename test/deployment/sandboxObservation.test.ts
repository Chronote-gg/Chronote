/** @jest-environment node */
import { marshall } from "@aws-sdk/util-dynamodb";
import { collectSandboxObservation } from "../../scripts/deployment/observe-sandbox.cjs";
import { manifestHash } from "../../scripts/deployment/sandbox-manifest.cjs";

const account = "123456789012",
  region = "us-east-1";
const ecs = `arn:aws:ecs:${region}:${account}`,
  elb = `arn:aws:elasticloadbalancing:${region}:${account}`;
const manifest = {
  environment: "sandbox",
  accountId: account,
  region,
  principalArn: `arn:aws:iam::${account}:user/deployer`,
  operationId: "d2e9e384-2efe-469e-84e1-8f9b82b794af",
  sourceCommit: "a".repeat(40),
  tablePrefix: "test-sandbox-",
  bucket: "test-sandbox-bucket",
  cluster: "test-sandbox-cluster",
  service: "test-sandbox-service",
  containerName: "test-sandbox-bot",
  containerPort: 3001,
  runtimeMode: "all",
  legacyTaskDefinition: `${ecs}:task-definition/test-sandbox-task:1`,
  taskDefinition: `${ecs}:task-definition/test-sandbox-task:2`,
  imageDigest: `sha256:${"b".repeat(64)}`,
  listenerArn: `${elb}:listener/app/sandbox/1/2`,
  targetGroupA: `${elb}:targetgroup/sandbox-a/1`,
  targetGroupB: `${elb}:targetgroup/sandbox-b/2`,
  maintenance: {
    testOnly: true,
    workSettled: true,
    receiptSha256: "c".repeat(64),
    confirmedAt: "2026-10-15T10:00:00.000Z",
  },
};
test("observer paginates projections, separates requested flags from outcomes and never emits returned content", async () => {
  const calls: {
    service: string;
    operation: string;
    input: Record<string, unknown>;
  }[] = [];
  let pages = 0;
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, unknown>,
  ) => {
    calls.push({ service, operation, input });
    if (service === "sts")
      return { Account: account, Arn: manifest.principalArn };
    if (service === "ecs" && operation === "describe-services")
      return {
        failures: [],
        services: [
          {
            serviceName: manifest.service,
            desiredCount: 1,
            runningCount: 1,
            pendingCount: 0,
            taskDefinition: manifest.taskDefinition,
          },
        ],
      };
    if (service === "ecs" && operation === "list-tasks")
      return { taskArns: [] };
    if (service === "elbv2" && operation === "describe-target-health")
      return { TargetHealthDescriptions: [] };
    if (service === "elbv2" && operation === "describe-listeners")
      return {
        Listeners: [
          {
            ListenerArn: manifest.listenerArn,
            DefaultActions: [
              {
                Type: "forward",
                ForwardConfig: {
                  TargetGroups: [
                    { TargetGroupArn: manifest.targetGroupA, Weight: 100 },
                    { TargetGroupArn: manifest.targetGroupB, Weight: 0 },
                  ],
                },
              },
            ],
          },
        ],
      };
    if (service === "dynamodb" && operation === "scan") {
      if (input.TableName === "test-sandbox-MeetingHistoryTable") {
        pages++;
        if (pages === 1)
          return {
            Items: [
              {
                timestamp: { S: "2026-10-15T09:00:00.000Z" },
                status: { S: "in_progress" },
                notes: { S: "PRIVATE" },
              },
            ],
            LastEvaluatedKey: { guildId: { S: "next" } },
          };
        return {
          Items: [
            {
              timestamp: { S: "2026-10-15T10:01:00.000Z" },
              status: { S: "in_progress" },
              updatedAt: { S: "2026-10-15T10:01:00.000Z" },
              notes: { S: "PRIVATE" },
              duration: { N: "0" },
            },
            {
              timestamp: { S: "2026-10-15T10:02:00.000Z" },
              status: { S: "complete" },
              transcribeMeeting: { BOOL: true },
              generateNotes: { BOOL: true },
              processing: {
                M: {
                  transcription: { S: "partial" },
                  notes: { S: "generated" },
                },
              },
              delivery: {
                M: {
                  notes: {
                    M: {
                      outcome: { S: "complete" },
                      sent: { N: "1" },
                      intended: { N: "1" },
                      errors: { L: [{ S: "PRIVATE" }] },
                    },
                  },
                },
              },
            },
          ],
        };
      }
      return { Items: [] };
    }
    throw new Error("Unexpected observer operation");
  };
  const r = await collectSandboxObservation({
    manifest,
    expectedSha256: manifestHash(manifest),
    aws,
    since: "2026-10-15T10:00:00.000Z",
    until: "2026-10-15T11:00:00.000Z",
    now: () => Date.parse("2026-10-15T11:00:00.000Z"),
  });
  expect(pages).toBe(2);
  expect(r.runtime).toMatchObject({
    expectedDigestTasks: 0,
    taskInventoryComplete: false,
  });
  expect(r.history).toMatchObject({
    records: 2,
    staleCandidates: 1,
    partialTranscriptions: 1,
    requestedTranscription: 1,
    deliveredNotes: 1,
  });
  expect(r.evidence).toMatchObject({
    crashRecovery: "NOT_OBSERVED",
    simultaneousMultiServerAdmission: "NOT_OBSERVED",
  });
  expect(JSON.stringify(r)).not.toContain("PRIVATE");
  const scans = calls.filter((c) => c.operation === "scan");
  expect(scans.every((c) => Boolean(c.input.ProjectionExpression))).toBe(true);
  expect(
    JSON.stringify(scans.map((c) => c.input.ExpressionAttributeNames)),
  ).not.toMatch(/"transcript"|"context"|"errors"/);
  expect(
    scans.every(
      (c) =>
        !String(c.input.ProjectionExpression)
          .split(",")
          .map((p) => p.trim())
          .includes("#notes"),
    ),
  ).toBe(true);
  expect(
    calls.every(
      (c) =>
        ![
          "update-service",
          "put-item",
          "update-item",
          "transact-write-items",
          "stop-task",
        ].includes(c.operation),
    ),
  ).toBe(true);
});
test("observer rejects an excessive window and mismatched identity before reading lifecycle data", async () => {
  let reads = 0;
  const aws = async () => {
    reads++;
    return { Account: "999999999999", Arn: "wrong" };
  };
  const args = {
    manifest,
    expectedSha256: manifestHash(manifest),
    aws,
    now: () => Date.parse("2026-10-16T10:00:00.000Z"),
  };
  await expect(
    collectSandboxObservation({
      ...args,
      since: "2026-10-14T10:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    }),
  ).rejects.toThrow();
  expect(reads).toBe(0);
  await expect(
    collectSandboxObservation({
      ...args,
      since: "2026-10-15T10:00:00.000Z",
      until: "2026-10-16T10:00:00.000Z",
    }),
  ).rejects.toThrow();
  expect(reads).toBe(1);
});

test("generation and delivery failures are preserved as distinct observation outcomes", async () => {
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, unknown>,
  ) => {
    if (service === "sts")
      return { Account: account, Arn: manifest.principalArn };
    if (service === "ecs" && operation === "describe-services")
      return {
        services: [
          {
            serviceName: manifest.service,
            desiredCount: 1,
            runningCount: 0,
            pendingCount: 0,
            taskDefinition: manifest.taskDefinition,
          },
        ],
      };
    if (service === "ecs" && operation === "list-tasks")
      return { taskArns: [] };
    if (service === "elbv2" && operation === "describe-target-health")
      return { TargetHealthDescriptions: [] };
    if (service === "elbv2" && operation === "describe-listeners")
      return { Listeners: [] };
    if (service === "dynamodb" && operation === "scan")
      return {
        Items:
          input.TableName === "test-sandbox-MeetingHistoryTable"
            ? [
                {
                  timestamp: { S: "2026-10-15T10:01:00.000Z" },
                  status: { S: "complete" },
                  processing: {
                    M: { notes: { S: "failed" }, summary: { S: "failed" } },
                  },
                  delivery: {
                    M: {
                      notes: { M: { outcome: { S: "failed" } } },
                      summary: { M: { outcome: { S: "partial" } } },
                    },
                  },
                },
                {
                  timestamp: { S: "2026-10-15T10:02:00.000Z" },
                  status: { S: "complete" },
                  processing: { M: { notes: { S: "skipped" } } },
                  delivery: {
                    M: { notes: { M: { outcome: { S: "not_applicable" } } } },
                  },
                },
                {
                  timestamp: { S: "2026-10-15T10:03:00.000Z" },
                  status: { S: "complete" },
                  processing: {
                    M: {
                      notes: { S: "generated" },
                      summary: { S: "generated" },
                    },
                  },
                  delivery: {
                    M: { notes: { M: { outcome: { S: "partial" } } } },
                  },
                },
              ]
            : [],
      };
    throw new Error("Unexpected operation");
  };
  const result = await collectSandboxObservation({
    manifest,
    expectedSha256: manifestHash(manifest),
    aws,
    since: "2026-10-15T10:00:00.000Z",
    until: "2026-10-15T11:00:00.000Z",
    now: () => Date.parse("2026-10-15T11:00:00.000Z"),
  });
  expect(result.history.outcomes).toMatchObject({
    notes: { failed: 1, skipped: 1, generated: 1 },
    summary: { failed: 1, unknown: 1, generated: 1 },
    notesDelivery: { failed: 1, not_applicable: 1, partial: 1 },
    summaryDelivery: { partial: 1, unknown: 2 },
  });
});

type ObservationRow = Record<string, unknown>;
function observationFixture() {
  const data: {
    tasks: ObservationRow[];
    history: ObservationRow[];
    leases: ObservationRow[];
    runtimes: ObservationRow[];
    controls: ObservationRow[];
  } = {
    tasks: [],
    history: [],
    leases: [],
    runtimes: [],
    controls: [],
  };
  const projections: string[] = [];
  const groups = [
    { TargetGroupArn: manifest.targetGroupA, Weight: 100 },
    { TargetGroupArn: manifest.targetGroupB, Weight: 0 },
  ];
  async function aws(
    service: string,
    operation: string,
    input: Record<string, unknown>,
  ) {
    if (service === "sts")
      return { Account: account, Arn: manifest.principalArn };
    if (operation === "describe-services")
      return {
        services: [
          {
            serviceName: manifest.service,
            desiredCount: 0,
            runningCount: data.tasks.filter(
              (task) => task.lastStatus === "RUNNING",
            ).length,
            pendingCount: 0,
            taskDefinition: manifest.taskDefinition,
          },
        ],
      };
    if (operation === "list-tasks")
      return { taskArns: data.tasks.map((task) => task.taskArn) };
    if (operation === "describe-tasks") return { tasks: data.tasks };
    if (operation === "get-task-protection")
      return {
        protectedTasks: data.tasks
          .filter((task) => task.lastStatus === "RUNNING")
          .map((task) => ({
            taskArn: task.taskArn,
            protectionEnabled: true,
            expirationDate: "2026-10-15T13:00:00.000Z",
          })),
      };
    if (operation === "describe-target-health")
      return { TargetHealthDescriptions: [] };
    if (operation === "describe-listeners")
      return {
        Listeners: [
          {
            ListenerArn: manifest.listenerArn,
            DefaultActions: [
              { Type: "forward", ForwardConfig: { TargetGroups: groups } },
            ],
          },
        ],
      };
    if (service === "dynamodb" && operation === "scan") {
      projections.push(JSON.stringify(input.ExpressionAttributeNames));
      const tables: Record<string, ObservationRow[]> = {
        [manifest.tablePrefix + "MeetingHistoryTable"]: data.history,
        [manifest.tablePrefix + "ActiveMeetingTable"]: data.leases,
        [manifest.tablePrefix + "DeploymentControlTable"]: data.runtimes,
        [manifest.tablePrefix + "MeetingControlCommandTable"]: data.controls,
      };
      return {
        Items: tables[String(input.TableName)].map((row) => marshall(row)),
      };
    }
    throw new Error("Unexpected generated observation operation");
  }
  const collect = (provider = aws) =>
    collectSandboxObservation({
      manifest,
      expectedSha256: manifestHash(manifest),
      aws: provider,
      since: "2026-10-15T10:00:00.000Z",
      until: "2026-10-15T11:00:00.000Z",
      now: () => Date.parse("2026-10-15T12:00:00.000Z"),
    });
  return { data, groups, projections, collect, aws };
}

test("successful summary send and edit outcomes stay distinct from absent metadata", async () => {
  const f = observationFixture();
  f.data.history = ["edited_existing", "sent_fallback"].map((outcome) => ({
    timestamp: "2026-10-15T10:01:00.000Z",
    status: "complete",
    delivery: { summary: { outcome } },
  }));
  expect((await f.collect()).history.outcomes.summaryDelivery).toEqual({
    edited_existing: 1,
    sent_fallback: 1,
  });
});

test("delivery uncertainty does not misclassify other recovery reconciliation reasons", async () => {
  const f = observationFixture();
  f.data.history = [
    "delivery_uncertain",
    "ownership_uncertain",
    "export_uncertain",
    "invalid_checkpoint",
    "invalid_payload",
    "transcript_overlap_unknown",
    "retry_exhausted",
    "policy_unknown",
  ].map((reason) => ({
    timestamp: "2026-10-15T10:01:00.000Z",
    status: "complete",
    recovery: { disposition: "needs_reconciliation", reason },
  }));
  expect((await f.collect()).history).toMatchObject({
    uncertainDelivery: 1,
    recoveryNeedsReconciliation: 8,
  });
  expect(f.projections.join(" ")).toContain('"reason"');
});

test("current readiness, control and lease expirations use collection time, not historical window end", async () => {
  const f = observationFixture();
  const expiresAt = Date.parse("2026-10-15T11:30:00.000Z") / 1000;
  f.data.runtimes = [
    { recordType: "runtime", role: "serving", readiness: { expiresAt } },
  ];
  f.data.controls = [{ queueStatus: "pending", expiresAt }];
  const identity = {
    guildId: "generated-guild",
    meetingId: "generated-meeting",
    ownerInstanceId: "generated-owner",
    executionVersion: 1,
  };
  f.data.leases = [{ ...identity, leaseExpiresAt: expiresAt }];
  f.data.history = [
    {
      ...identity,
      timestamp: "2026-10-15T10:50:00.000Z",
      status: "processing",
    },
  ];
  const result = await f.collect();
  expect(result.runtime).toMatchObject({
    staleReadiness: 1,
    unexpiredQueuedControls: 0,
  });
  expect(result.history.staleCandidates).toBe(1);
});

test.each([manifest.targetGroupA, manifest.targetGroupB])(
  "duplicate routing group %s is UNKNOWN",
  async (TargetGroupArn) => {
    const f = observationFixture();
    f.groups[0].TargetGroupArn = TargetGroupArn;
    f.groups[1].TargetGroupArn = TargetGroupArn;
    expect((await f.collect()).routing).toBe("UNKNOWN");
  },
);

test.each(["initialized", "launch_submitted", "launched", "complete"])(
  "bootstrap receipt stage %s is included in deployment status",
  async (stage) => {
    const f = observationFixture();
    f.data.runtimes = [
      { pk: "ENV", sk: "CONTROL" },
      { pk: "ENV", sk: "BOOTSTRAP#generated-operation", stage },
    ];
    expect((await f.collect()).runtime.deploymentIncomplete).toBe(
      stage !== "complete",
    );
    expect(f.projections.join(" ")).toContain('"stage"');
  },
);

test("interrupted recording without a live lease remains eligible for stale investigation", async () => {
  const f = observationFixture();
  f.data.history = [
    { timestamp: "2026-10-15T10:01:00.000Z", status: "interrupted" },
  ];
  expect((await f.collect()).history.staleCandidates).toBe(1);
});

test("an unfinished scan at the page bound refuses a complete observation", async () => {
  const f = observationFixture();
  let pages = 0;
  await expect(
    f.collect(
      async (
        service: string,
        operation: string,
        input: Record<string, unknown>,
      ) => {
        if (service === "dynamodb" && operation === "scan") {
          pages++;
          return {
            Items: [],
            LastEvaluatedKey: { guildId: { S: "generated-next-page" } },
          };
        }
        return f.aws(service, operation, input);
      },
    ),
  ).rejects.toThrow("Observation scan incomplete");
  expect(pages).toBe(100);
});

test.each([
  "done",
  "failed",
  "pending",
  "claimed",
  "needs_reconciliation",
  undefined,
])(
  "interrupted recovery disposition %s is classified by settlement",
  async (disposition) => {
    const f = observationFixture();
    f.data.history = [
      {
        timestamp: "2026-10-15T10:01:00.000Z",
        status: "interrupted",
        ...(disposition ? { recovery: { disposition } } : {}),
      },
    ];
    const result = await f.collect();
    expect(result.history.staleCandidates).toBe(disposition === "done" ? 0 : 1);
    expect(result.history.outcomes.recovery).toEqual({
      [disposition ?? "unknown"]: 1,
    });
  },
);

test("native protection is queried only for running tasks during retirement", async () => {
  const f = observationFixture();
  const runningArn = `${ecs}:task/test-sandbox-cluster/running`;
  f.data.tasks = [
    {
      taskArn: runningArn,
      lastStatus: "RUNNING",
      containers: [
        { name: manifest.containerName, imageDigest: manifest.imageDigest },
      ],
    },
    {
      taskArn: `${ecs}:task/test-sandbox-cluster/recently-stopped`,
      lastStatus: "STOPPED",
    },
  ];
  let protectionQueries = 0;
  const result = await f.collect(
    async (
      service: string,
      operation: string,
      input: Record<string, unknown>,
    ) => {
      if (operation === "get-task-protection") {
        protectionQueries++;
        expect(input.tasks).toEqual([runningArn]);
      }
      return f.aws(service, operation, input);
    },
  );
  expect(protectionQueries).toBe(1);
  expect(result.runtime).toMatchObject({
    nativeProtectedTasks: 1,
    expectedDigestTasks: 1,
    taskInventoryComplete: false,
  });
});

test("a superseded bootstrap settles only with its linked completed repair and replacement", async () => {
  const f = observationFixture();
  const original = {
    pk: "ENV",
    sk: "BOOTSTRAP#old",
    operationId: "old",
    stage: "superseded",
    supersededBy: "new",
  };
  const replacement = {
    pk: "ENV",
    sk: "BOOTSTRAP#new",
    operationId: "new",
    stage: "complete",
  };
  const repair = {
    pk: "ENV",
    sk: "REPAIR#new",
    operationId: "new",
    previousOperationId: "old",
    stage: "complete",
  };
  f.data.runtimes = [original, replacement, repair];
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(false);
  repair.previousOperationId = "foreign";
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(true);
  repair.previousOperationId = "old";
  f.data.runtimes = [original, replacement];
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(true);
  f.data.runtimes = [original, repair];
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(true);
  expect(f.projections.join(" ")).toContain('"supersededBy"');
  expect(f.projections.join(" ")).toContain('"previousOperationId"');
});

test.each([
  "reserved",
  "stop_submitted",
  "stop_acknowledged",
  "initialized",
  "complete",
])("repair receipt stage %s remains visible", async (stage) => {
  const f = observationFixture();
  f.data.runtimes = [{ pk: "ENV", sk: "REPAIR#new", stage }];
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(
    stage !== "complete",
  );
});

test("a non-complete introduction remains incomplete after bootstrap promotion", async () => {
  const f = observationFixture();
  f.data.runtimes = [
    { pk: "ENV", sk: "BOOTSTRAP#new", stage: "complete" },
    { pk: "ENV", sk: "INTRODUCTION", stage: "routing_acknowledged" },
  ];
  expect((await f.collect()).runtime.deploymentIncomplete).toBe(true);
});

test("historical carryforward does not hide pending source settlement", async () => {
  const f = observationFixture();
  f.data.runtimes.push({
    pk: "SOURCELOSS#run",
    sk: "RECOVERY",
    recordType: "source_loss_recovery",
    stage: "availability_restored",
    settlement: "lost_owner_settlement_pending",
  });
  f.data.runtimes.push({
    pk: "CARRYFORWARD#approved",
    sk: "ARCHIVE",
    recordType: "historical_deployment_carryforward",
    version: 1,
    settlement: "lost_owner_settlement_pending",
  });
  const result = await f.collect();
  expect(result.runtime.sourceLoss).toMatchObject({
    availabilityRestored: 1,
    settlementPending: 1,
    historicalCarryforwards: 1,
  });
  expect(result.runtime.deploymentIncomplete).toBe(true);
});

test("observer labels retained terminal evidence without claiming current native STOPPED", async () => {
  const f = observationFixture();
  f.data.runtimes.push({
    pk: "SOURCELOSS#run",
    sk: "RECOVERY",
    recordType: "source_loss_recovery",
    version: 2,
    stage: "availability_restored",
    settlement: "lost_owner_settlement_pending",
    terminalProof: {
      kind: "operator_retained_ecs_stop",
      nativeObservation: "MISSING",
    },
  });
  const result = await f.collect();
  expect(result.runtime.sourceLoss).toMatchObject({
    retainedTerminalProofs: 1,
    sourceMissingAtAdmission: 1,
    settlementPending: 1,
  });
  expect(result.runtime.deploymentIncomplete).toBe(true);
});
