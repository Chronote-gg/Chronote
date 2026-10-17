import { randomUUID, createHash } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../src/services/deploymentControlTransactions";
import * as types from "../../src/types/deploymentControl";
import { createIntroduction } from "../../scripts/deployment/introduce-sandbox.cjs";
import { createBootstrap } from "../../scripts/deployment/bootstrap-sandbox.cjs";

const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "local",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
const created: string[] = [];
afterAll(async () => {
  for (const TableName of created)
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});
async function fixture() {
  const account = "123456789012",
    region = "us-east-1";
  const prefix = `test-sandbox-${randomUUID()}-`;
  const table = `${prefix}DeploymentControlTable`;
  const leaseTable = `${prefix}ActiveMeetingTable`;
  for (const [TableName, keys] of [
    [table, ["pk", "sk"]],
    [leaseTable, ["guildId"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keys.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index ? "RANGE" : "HASH",
        })),
        AttributeDefinitions: keys.map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
    created.push(TableName);
  }
  const ecs = `arn:aws:ecs:${region}:${account}`;
  const elb = `arn:aws:elasticloadbalancing:${region}:${account}`;
  const manifest = {
    environment: "sandbox",
    accountId: account,
    region,
    principalArn: `arn:aws:iam::${account}:user/test-deployer`,
    operationId: randomUUID(),
    sourceCommit: "a".repeat(40),
    tablePrefix: prefix,
    bucket: "test-sandbox-bucket",
    cluster: "test-sandbox-cluster",
    service: "test-sandbox-service",
    legacyTaskDefinition: `${ecs}:task-definition/test-sandbox-task:1`,
    taskDefinition: `${ecs}:task-definition/test-sandbox-task:2`,
    imageDigest: `sha256:${"b".repeat(64)}`,
    containerName: "test-sandbox-bot",
    runtimeMode: "all",
    containerPort: 3001,
    listenerArn: `${elb}:listener/app/test-sandbox/1/2`,
    targetGroupA: `${elb}:targetgroup/test-sandbox-a/1`,
    targetGroupB: `${elb}:targetgroup/test-sandbox-b/2`,
    maintenance: {
      testOnly: true,
      workSettled: true,
      receiptSha256: "c".repeat(64),
      confirmedAt: new Date(1000 * 1000).toISOString(),
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const state = {
    desired: 0,
    running: false,
    nativeProtected: true,
    proofExpires: 2000,
    launchUnknown: false,
    transactionLost: false,
    updates: 0,
  };
  const taskArn = `${ecs}:task/test-sandbox-cluster/test-task`;
  const identity = {
    kind: "ecs",
    instanceId: "runtime",
    protocolVersion: 1,
    candidateId: manifest.operationId,
    imageDigest: manifest.imageDigest,
    taskArn,
  };
  const controlKey = { pk: "ENV", sk: "CONTROL" };
  async function get(sk: string) {
    const out = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall({ pk: "ENV", sk }),
        ConsistentRead: true,
      }),
    );
    return out.Item ? unmarshall(out.Item) : undefined;
  }
  async function aws(
    service: string,
    operation: string,
    input: Record<string, never>,
  ) {
    if (service === "dynamodb") {
      if (operation === "get-item")
        return client.send(new GetItemCommand(input));
      if (operation === "scan") return client.send(new ScanCommand(input));
      if (operation === "transact-write-items") {
        const result = await client.send(new TransactWriteItemsCommand(input));
        if (state.transactionLost) {
          state.transactionLost = false;
          throw new Error("ACK lost after apply");
        }
        return result;
      }
    }
    if (service === "sts")
      return { Account: account, Arn: manifest.principalArn };
    if (service === "ecs") {
      if (operation === "describe-services")
        return {
          failures: [],
          services: [
            {
              serviceName: manifest.service,
              taskDefinition: state.desired
                ? manifest.taskDefinition
                : manifest.legacyTaskDefinition,
              desiredCount: state.desired,
              runningCount: state.running ? 1 : 0,
              pendingCount: 0,
              loadBalancers: [
                {
                  targetGroupArn: manifest.targetGroupA,
                  containerName: manifest.containerName,
                  containerPort: 3001,
                },
              ],
            },
          ],
        };
      if (operation === "list-tasks")
        return { taskArns: state.running ? [taskArn] : [] };
      if (operation === "describe-tasks")
        return {
          failures: [],
          tasks: state.running
            ? [
                {
                  taskArn,
                  taskDefinitionArn: manifest.taskDefinition,
                  lastStatus: "RUNNING",
                  containers: [
                    {
                      name: manifest.containerName,
                      imageDigest: manifest.imageDigest,
                      networkInterfaces: [{ privateIpv4Address: "10.0.0.1" }],
                    },
                  ],
                },
              ]
            : [],
        };
      if (operation === "describe-task-definition")
        return {
          taskDefinition: {
            taskDefinitionArn: manifest.taskDefinition,
            status: "ACTIVE",
            containerDefinitions: [
              {
                name: manifest.containerName,
                image: `test.invalid/sandbox@${manifest.imageDigest}`,
                command: ["node", "dist/index.js"],
                stopTimeout: 120,
                environment: [
                  { name: "DDB_TABLE_PREFIX", value: prefix },
                  { name: "TRANSCRIPTS_BUCKET", value: manifest.bucket },
                  {
                    name: "DEPLOYMENT_CANDIDATE_ID",
                    value: manifest.operationId,
                  },
                ],
              },
            ],
          },
        };
      if (operation === "get-task-protection")
        return {
          failures: [],
          protectedTasks: [
            {
              taskArn,
              protectionEnabled: state.nativeProtected,
              expirationDate: new Date(state.proofExpires * 1000).toISOString(),
            },
          ],
        };
      if (operation === "update-service") {
        state.updates++;
        state.desired = 1;
        state.running = true;
        const ctl = await get("CONTROL");
        await client.send(
          new PutItemCommand({
            TableName: table,
            Item: marshall({
              pk: "ENV",
              sk: "RUNTIME#runtime",
              recordType: "runtime",
              identity,
              role: "candidate",
              authorizedGeneration: 0,
              heartbeatAt: 1000,
              readiness: {
                identity,
                runtimeMode: "all",
                observedEpoch: ctl!.coordinatorEpoch,
                observedGeneration: 0,
                gatewayReady: true,
                cacheReady: true,
                dependenciesReady: true,
                provenAt: 1000,
                expiresAt: 1030,
              },
              protection: { identity, provenAt: 1000, expiresAt: 2000 },
              workCounts: {
                pending_admission: 0,
                recording: 0,
                finalization: 0,
                personal_processing: 0,
                recovery_processing: 0,
                voice_operation: 0,
                ancillary_delivery: 0,
              },
            }),
          }),
        );
        if (state.launchUnknown) throw new Error("UpdateService response lost");
        return { service: { taskDefinition: manifest.taskDefinition } };
      }
    }
    if (service === "elbv2") {
      if (operation === "describe-listeners")
        return {
          Listeners: [
            {
              ListenerArn: manifest.listenerArn,
              Protocol: "HTTPS",
              LoadBalancerArn: "lb",
              DefaultActions: [
                {
                  Type: "forward",
                  ForwardConfig: {
                    TargetGroups: [
                      { TargetGroupArn: manifest.targetGroupA, Weight: 100 },
                      { TargetGroupArn: manifest.targetGroupB, Weight: 0 },
                    ],
                    TargetGroupStickinessConfig: { Enabled: false },
                  },
                },
              ],
            },
          ],
        };
      if (operation === "describe-rules")
        return { Rules: [{ IsDefault: true }] };
      if (operation === "describe-target-groups")
        return {
          TargetGroups: [manifest.targetGroupA, manifest.targetGroupB].map(
            (TargetGroupArn) => ({
              TargetGroupArn,
              TargetType: "ip",
              Protocol: "HTTP",
              Port: 3001,
              VpcId: "sandbox-vpc",
              HealthCheckPath: "/health",
              LoadBalancerArns: ["lb"],
            }),
          ),
        };
      if (operation === "describe-target-group-attributes")
        return { Attributes: [{ Key: "stickiness.enabled", Value: "false" }] };
      if (operation === "describe-target-health") {
        const group = (input as Record<string, unknown>).TargetGroupArn;
        return {
          TargetHealthDescriptions:
            state.running && group === manifest.targetGroupA
              ? [
                  {
                    Target: { Id: "10.0.0.1", Port: 3001 },
                    TargetHealth: { State: "healthy" },
                  },
                ]
              : [],
        };
      }
    }
    throw new Error(`Unexpected ${service}.${operation}`);
  }
  const bootstrap = createBootstrap({
    manifest,
    expectedSha256: hash,
    aws,
    builders,
    types,
    now: () => 1000,
  });
  return {
    manifest,
    hash,
    state,
    bootstrap,
    get,
    table,
    leaseTable,
    controlKey,
    aws,
  };
}
test("cold bootstrap uses real conditional writes, self registration and promotion; restart does not launch twice", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.initialize();
  expect((await f.get("CONTROL"))?.servingMembers).toEqual({});
  await f.bootstrap.launch();
  await f.bootstrap.launch();
  await f.bootstrap.promote();
  await f.bootstrap.promote();
  expect(f.state.updates).toBe(1);
  expect(await f.get("CONTROL")).toMatchObject({
    servingGeneration: 1,
    coordinatorExpiresAt: 0,
  });
  expect(await f.get("RUNTIME#runtime")).toMatchObject({
    role: "serving",
    authorizedGeneration: 1,
  });
});
test("live legacy tasks and nonterminal leases refuse initialization without touching Control", async () => {
  const f = await fixture();
  f.state.running = true;
  await expect(f.bootstrap.initialize()).rejects.toThrow();
  expect(await f.get("CONTROL")).toBeUndefined();
  f.state.running = false;
  await client.send(
    new PutItemCommand({
      TableName: f.leaseTable,
      Item: marshall({
        guildId: "fixture",
        status: "in_progress",
        leaseExpiresAt: 900,
      }),
    }),
  );
  await expect(f.bootstrap.initialize()).rejects.toThrow();
  expect(await f.get("CONTROL")).toBeUndefined();
});
test("checksum and identity mismatch refuse all mutations", async () => {
  const f = await fixture();
  expect(() =>
    createBootstrap({
      manifest: f.manifest,
      expectedSha256: "0".repeat(64),
      aws: f.aws,
      builders,
      types,
      now: () => 1000,
    }),
  ).toThrow();
  const wrong = async (s: string, o: string, i: Record<string, never>) =>
    s === "sts"
      ? { Account: "999999999999", Arn: f.manifest.principalArn }
      : f.aws(s, o, i);
  await expect(
    createBootstrap({
      manifest: f.manifest,
      expectedSha256: f.hash,
      aws: wrong,
      builders,
      types,
      now: () => 1000,
    }).initialize(),
  ).rejects.toThrow();
  expect(await f.get("CONTROL")).toBeUndefined();
});
test("concurrent operators cannot overwrite Control", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.bootstrap.initialize(),
    f.bootstrap.initialize(),
  ]);
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.manifest.operationId,
  });
  await client.send(
    new PutItemCommand({
      TableName: f.table,
      Item: marshall({
        ...(await f.get("CONTROL")),
        coordinatorToken: "foreign",
      }),
    }),
  );
  await expect(f.bootstrap.initialize()).rejects.toThrow();
});
test("lost Dynamo acknowledgment reconciles exact receipt without resubmission", async () => {
  const f = await fixture();
  f.state.transactionLost = true;
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  f.state.transactionLost = true;
  await f.bootstrap.promote();
  expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 1 });
});
test("unknown UpdateService outcome never replays or permits promotion despite matching readback", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  f.state.launchUnknown = true;
  await expect(f.bootstrap.launch()).rejects.toThrow();
  await expect(f.bootstrap.launch()).rejects.toThrow();
  await expect(f.bootstrap.promote()).rejects.toThrow();
  expect(f.state.updates).toBe(1);
  expect((await f.get("CONTROL"))?.servingGeneration).toBe(0);
});
test("stale readiness or insufficient native protection refuses promotion", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  f.state.nativeProtected = false;
  await expect(f.bootstrap.promote()).rejects.toThrow();
  f.state.nativeProtected = true;
  f.state.proofExpires = 1100;
  await expect(f.bootstrap.promote()).rejects.toThrow();
  const row = (await f.get("RUNTIME#runtime"))!;
  row.readiness.expiresAt = 999;
  f.state.proofExpires = 2000;
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
  );
  await expect(f.bootstrap.promote()).rejects.toThrow();
  expect((await f.get("CONTROL"))?.servingGeneration).toBe(0);
});

test("concurrent launch attempts dispatch UpdateService only once", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  const results = await Promise.allSettled([
    f.bootstrap.launch(),
    f.bootstrap.launch(),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.state.updates).toBe(1);
});
test("missing candidate work accounting refuses promotion", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  const row = (await f.get("RUNTIME#runtime"))!;
  delete row.workCounts;
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
  );
  await expect(f.bootstrap.promote()).rejects.toThrow();
  expect((await f.get("CONTROL"))?.servingGeneration).toBe(0);
});

test.each(["wrong", "missing", "duplicate", "secret"] as const)(
  "prepared %s recording bucket refuses launch before external mutation",
  async (mode) => {
    const f = await fixture();
    await f.bootstrap.initialize();
    const aws = async (
      service: string,
      operation: string,
      input: Record<string, never>,
    ) => {
      const result = await f.aws(service, operation, input);
      if (
        service === "ecs" &&
        operation === "describe-task-definition" &&
        "taskDefinition" in result &&
        result.taskDefinition
      ) {
        const definition = result;
        const container = definition.taskDefinition.containerDefinitions[0];
        container.environment = container.environment.filter(
          (e) => e.name !== "TRANSCRIPTS_BUCKET",
        );
        if (mode === "wrong")
          container.environment.push({
            name: "TRANSCRIPTS_BUCKET",
            value: "different-bucket",
          });
        if (mode === "duplicate")
          container.environment.push(
            ...[1, 2].map(() => ({
              name: "TRANSCRIPTS_BUCKET",
              value: f.manifest.bucket,
            })),
          );
        if (mode === "secret")
          return {
            ...definition,
            taskDefinition: {
              ...definition.taskDefinition,
              containerDefinitions: [
                {
                  ...container,
                  secrets: [
                    {
                      name: "TRANSCRIPTS_BUCKET",
                      valueFrom: "ambiguous-secret",
                    },
                  ],
                },
              ],
            },
          };
      }
      return result;
    };
    const bootstrap = createBootstrap({
      manifest: f.manifest,
      expectedSha256: f.hash,
      aws,
      builders,
      types,
      now: () => 1000,
    });
    await expect(bootstrap.launch()).rejects.toThrow();
    expect(f.state.updates).toBe(0);
  },
);

test("changed empty service definition refuses launch instead of overriding another operation", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, never>,
  ) => {
    const result = await f.aws(service, operation, input);
    if (
      service === "ecs" &&
      operation === "describe-services" &&
      "services" in result &&
      result.services
    )
      result.services[0].taskDefinition = f.manifest.taskDefinition;
    return result;
  };
  const bootstrap = createBootstrap({
    manifest: f.manifest,
    expectedSha256: f.hash,
    aws,
    builders,
    types,
    now: () => 1000,
  });
  await expect(bootstrap.launch()).rejects.toThrow();
  expect(f.state.updates).toBe(0);
});

test("launch uses the ECS early-success request contract", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  const bootstrap = createBootstrap({
    manifest: f.manifest,
    expectedSha256: f.hash,
    builders,
    types,
    now: () => 1000,
    aws: async (
      service: string,
      operation: string,
      input: Record<string, never>,
    ) => {
      if (service === "ecs" && operation === "update-service")
        expect(input).toMatchObject({
          deploymentConfiguration: {
            earlySuccessCriteria: {
              enable: true,
              healthyPercent: 100,
              sourceServiceRevisionCleanup: "DEFERRED",
            },
          },
        });
      return f.aws(service, operation, input);
    },
  });
  await expect(bootstrap.launch()).resolves.toEqual({ kind: "launched" });
});

test.each([false, true])(
  "listener duration with stickiness enabled=%s follows the no-stickiness contract",
  async (enabled) => {
    const f = await fixture();
    const bootstrap = createBootstrap({
      manifest: f.manifest,
      expectedSha256: f.hash,
      builders,
      types,
      now: () => 1000,
      aws: async (
        service: string,
        operation: string,
        input: Record<string, never>,
      ) => {
        const result = await f.aws(service, operation, input);
        if ("Listeners" in result)
          return {
            ...result,
            Listeners: result.Listeners.map((listener) => ({
              ...listener,
              DefaultActions: listener.DefaultActions.map((action) => ({
                ...action,
                ForwardConfig: {
                  ...action.ForwardConfig,
                  TargetGroupStickinessConfig: {
                    Enabled: enabled,
                    DurationSeconds: 1,
                  },
                },
              })),
            })),
          };
        return result;
      },
    });
    if (enabled) {
      await expect(bootstrap.initialize()).rejects.toThrow("Weighted routing");
      expect(await f.get("CONTROL")).toBeUndefined();
    } else {
      await bootstrap.initialize();
      await bootstrap.launch();
      await expect(bootstrap.promote()).resolves.toMatchObject({
        kind: "complete",
      });
    }
  },
);

test.each(["DDB_TABLE_PREFIX", "DEPLOYMENT_CANDIDATE_ID"])(
  "secret override of %s refuses launch before provider mutation",
  async (name) => {
    const f = await fixture();
    await f.bootstrap.initialize();
    const bootstrap = createBootstrap({
      manifest: f.manifest,
      expectedSha256: f.hash,
      builders,
      types,
      now: () => 1000,
      aws: async (
        service: string,
        operation: string,
        input: Record<string, never>,
      ) => {
        const result = await f.aws(service, operation, input);
        if (
          operation === "describe-task-definition" &&
          "taskDefinition" in result &&
          result.taskDefinition
        )
          return {
            ...result,
            taskDefinition: {
              ...result.taskDefinition,
              containerDefinitions:
                result.taskDefinition.containerDefinitions.map((container) => ({
                  ...container,
                  secrets: [{ name, valueFrom: "generated-secret-reference" }],
                })),
            },
          };
        return result;
      },
    });
    await expect(bootstrap.launch()).rejects.toThrow(
      "Prepared candidate definition mismatch",
    );
    expect(f.state.updates).toBe(0);
    expect((await f.get("BOOTSTRAP#" + f.manifest.operationId))?.stage).toBe(
      "initialized",
    );
  },
);

test.each(["INACTIVE", "DELETE_IN_PROGRESS", undefined])(
  "unusable candidate definition status %s refuses before claiming launch",
  async (status) => {
    const f = await fixture();
    await f.bootstrap.initialize();
    const bootstrap = createBootstrap({
      manifest: f.manifest,
      expectedSha256: f.hash,
      builders,
      types,
      now: () => 1000,
      aws: async (
        service: string,
        operation: string,
        input: Record<string, never>,
      ) => {
        const result = await f.aws(service, operation, input);
        if (
          operation === "describe-task-definition" &&
          "taskDefinition" in result &&
          result.taskDefinition
        )
          return {
            ...result,
            taskDefinition: { ...result.taskDefinition, status },
          };
        return result;
      },
    });
    await expect(bootstrap.launch()).rejects.toThrow(
      "Prepared candidate definition mismatch",
    );
    expect(f.state.updates).toBe(0);
    expect((await f.get("BOOTSTRAP#" + f.manifest.operationId))?.stage).toBe(
      "initialized",
    );
  },
);

test("initialization accepts only the exact acknowledged introduction receipt", async () => {
  const f = await fixture();
  await client.send(
    new PutItemCommand({
      TableName: f.table,
      Item: marshall({
        pk: "ENV",
        sk: "INTRODUCTION",
        operationId: f.manifest.operationId,
        manifestSha256: f.hash,
        principalArn: f.manifest.principalArn,
        stage: "routing_acknowledged",
      }),
    }),
  );
  await f.bootstrap.initialize();
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.manifest.operationId,
  });
  expect(await f.get("INTRODUCTION")).toMatchObject({
    stage: "routing_acknowledged",
  });
});
test.each(["routing_submitted", "foreign_owner"])(
  "refuses an unconfirmed or foreign introduction: %s",
  async (kind) => {
    const f = await fixture();
    await client.send(
      new PutItemCommand({
        TableName: f.table,
        Item: marshall({
          pk: "ENV",
          sk: "INTRODUCTION",
          operationId:
            kind === "foreign_owner" ? randomUUID() : f.manifest.operationId,
          manifestSha256: f.hash,
          principalArn: f.manifest.principalArn,
          stage: kind === "routing_submitted" ? kind : "routing_acknowledged",
        }),
      }),
    );
    await expect(f.bootstrap.initialize()).rejects.toThrow();
    expect(await f.get("CONTROL")).toBeUndefined();
  },
);

// Execute the introduction runner's projection against DynamoDB's real parser.
// AWS stubs in the introduction unit suite do not validate reserved words.
test("introduction readiness projection is accepted by native DynamoDB", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(
    "scripts/deployment/introduce-sandbox.cjs",
    "utf8",
  );
  const readiness = source.slice(
    source.indexOf("async function runtimeReady("),
  );
  const projection = readiness.match(/ProjectionExpression: "([^"]+)"/);
  const aliases = readiness.match(/ExpressionAttributeNames: (\{[^}]+\})/);
  expect(projection).not.toBeNull();
  expect(aliases).not.toBeNull();
  const names = Object.fromEntries(
    [...aliases![1].matchAll(/"([^"]+)": "([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  const result = await client.send(
    new ScanCommand({
      TableName: f.table,
      ProjectionExpression: projection![1],
      ExpressionAttributeNames: names,
      ConsistentRead: true,
    }),
  );
  expect(result.Items?.map((item) => unmarshall(item))).toContainEqual(
    expect.objectContaining({
      recordType: "runtime",
      identity: expect.objectContaining({
        candidateId: f.manifest.operationId,
      }),
    }),
  );
});

test("read-only promotion readiness waits for ALB health and ignores replaced runtime rows", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  const runtime = await f.get("RUNTIME#runtime");
  await client.send(
    new PutItemCommand({
      TableName: f.table,
      Item: marshall({
        ...runtime,
        sk: "RUNTIME#replaced",
        identity: {
          ...runtime!.identity,
          instanceId: "replaced",
          taskArn: "replaced",
        },
      }),
    }),
  );
  let healthy = false;
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, never>,
  ) => {
    const response = await f.aws(service, operation, input);
    if (
      service === "elbv2" &&
      operation === "describe-target-health" &&
      !healthy
    )
      for (const target of response.TargetHealthDescriptions ?? [])
        target.TargetHealth.State = "initial";
    return response;
  };
  const bootstrap = createBootstrap({
    manifest: f.manifest,
    expectedSha256: f.hash,
    aws,
    builders,
    types,
    now: () => 1000,
  });
  await expect(bootstrap.readiness()).resolves.toEqual({ kind: "waiting" });
  await expect(bootstrap.promote()).rejects.toMatchObject({
    code: "candidate_not_ready",
  });
  expect((await f.get("CONTROL"))?.servingGeneration).toBe(0);
  expect((await f.get("BOOTSTRAP#" + f.manifest.operationId))?.stage).toBe(
    "launched",
  );
  healthy = true;
  await expect(bootstrap.readiness()).resolves.toEqual({ kind: "ready" });
  expect((await f.get("CONTROL"))?.servingGeneration).toBe(0);
  await expect(bootstrap.promote()).resolves.toEqual({
    kind: "complete",
    generation: 1,
  });
});

async function promotedIntroduction() {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  await f.bootstrap.promote();
  const runtime = await f.get("RUNTIME#runtime");
  runtime!.readiness.observedGeneration = 1;
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(runtime) }),
  );
  await client.send(
    new PutItemCommand({
      TableName: f.table,
      Item: marshall({
        pk: "ENV",
        sk: "INTRODUCTION",
        operationId: f.manifest.operationId,
        manifestSha256: f.hash,
        principalArn: f.manifest.principalArn,
        stage: "routing_acknowledged",
      }),
    }),
  );
  return f;
}

test.each(["before", "after"])(
  "activation reconciles completion-only after an uncertain %s acknowledgment",
  async (mode) => {
    const f = await promotedIntroduction();
    let lost = mode;
    const aws = async (
      service: string,
      operation: string,
      input: Record<string, never>,
    ) => {
      const completing =
        service === "dynamodb" &&
        operation === "transact-write-items" &&
        JSON.stringify(input).includes('"complete"');
      const failure = completing ? lost : "";
      if (completing) lost = "";
      if (failure === "before") throw new Error("completion not applied");
      const out = await f.aws(service, operation, input);
      if (failure === "after")
        throw new Error("completion acknowledgment lost");
      return out;
    };
    const intro = createIntroduction({
      manifest: f.manifest,
      expectedSha256: f.hash,
      aws,
      bootstrap: f.bootstrap,
      now: () => 1000,
    });
    await expect(intro.activate()).rejects.toThrow();
    const launches = f.state.updates;
    await expect(intro.activate()).resolves.toMatchObject({ kind: "complete" });
    expect(await f.get("INTRODUCTION")).toMatchObject({ stage: "complete" });
    expect(f.state.updates).toBe(launches);
  },
);

test.each(["repair-lineage", "repair-receipt"])(
  "activation completion refuses foreign %s",
  async (kind) => {
    const f = await promotedIntroduction();
    const row =
      kind === "repair-lineage"
        ? await f.get("INTRODUCTION")
        : { pk: "ENV", sk: "REPAIR#" + f.manifest.operationId };
    row!.previousOperationId = randomUUID();
    await client.send(
      new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
    );
    const intro = createIntroduction({
      manifest: f.manifest,
      expectedSha256: f.hash,
      aws: f.aws,
      bootstrap: f.bootstrap,
      now: () => 1000,
    });
    await expect(intro.activate()).rejects.toThrow();
    expect(await f.get("INTRODUCTION")).toMatchObject({
      stage: "routing_acknowledged",
    });
  },
);

async function repairFixture() {
  const f = await fixture();
  const previous = {
    ...f.manifest,
    operationId: randomUUID(),
    sourceCommit: "b".repeat(40),
    taskDefinition: f.manifest.legacyTaskDefinition,
    legacyTaskDefinition: f.manifest.legacyTaskDefinition.replace(/:1$/, ":0"),
    imageDigest: "sha256:" + "c".repeat(64),
  };
  const previousHash = createHash("sha256")
    .update(JSON.stringify(previous))
    .digest("hex");
  const rows = [
    {
      pk: "ENV",
      sk: "CONTROL",
      recordType: "control",
      runtimeEnvironment: "ecs",
      protocolVersion: 1,
      coordinatorToken: previous.operationId,
      coordinatorEpoch: 1,
      coordinatorExpiresAt: 999,
      servingGeneration: 0,
      servingMembers: {},
    },
    {
      pk: "ENV",
      sk: "BOOTSTRAP#" + previous.operationId,
      operationId: previous.operationId,
      manifestSha256: previousHash,
      stage: "launched",
      launchAttemptId: randomUUID(),
    },
    {
      pk: "ENV",
      sk: "INTRODUCTION",
      operationId: previous.operationId,
      manifestSha256: previousHash,
      principalArn: previous.principalArn,
      stage: "routing_acknowledged",
    },
  ];
  for (const row of rows)
    await client.send(
      new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
    );
  const calls: { service: string; operation: string }[] = [];
  const state = {
    stopped: false,
    lostStop: false,
    lostTransfer: false,
    lostCompletion: "",
    raceReservation: false,
    slowIntent: false,
    slowTransfer: false,
    protectedTask: false,
    foreignTarget: false,
    lateTopology: "",
    raceCompletion: false,
    oldTask: "none",
    containerStatus: "STOPPED",
    desiredTaskStatus: "STOPPED",
    targetState: "",
    missingContainers: false,
    holdTaskAfterStop: false,
    waits: 0,
    seconds: 1000,
  };
  async function providerRead(
    service: string,
    operation: string,
    input: Record<string, never>,
  ) {
    if (
      service === "dynamodb" &&
      operation === "scan" &&
      input.Select === "COUNT" &&
      input.TableName !== f.table &&
      input.TableName !== f.leaseTable
    )
      return { Count: 0 };
    if (service === "ecs" && operation === "describe-services") {
      return {
        failures: [],
        services: [
          {
            serviceName: f.manifest.service,
            taskDefinition: previous.taskDefinition,
            desiredCount: state.stopped ? 0 : 1,
            runningCount: 0,
            pendingCount: 0,
            loadBalancers: [
              {
                targetGroupArn: f.manifest.targetGroupA,
                containerName: f.manifest.containerName,
                containerPort: f.manifest.containerPort,
              },
            ],
          },
        ],
      };
    }
    if (service === "ecs" && operation === "describe-task-definition") {
      const out = await f.aws(service, operation, input);
      out.taskDefinition.containerDefinitions[0].image =
        "123456789012.dkr.ecr.us-east-1.amazonaws.com/test-sandbox-repo@" +
        f.manifest.imageDigest;
      return out;
    }
    if (service === "ecr")
      return {
        imageDetails: [
          {
            imageDigest: f.manifest.imageDigest,
            imageTags: [f.manifest.sourceCommit],
          },
        ],
      };
    return f.aws(service, operation, input);
  }

  const oldArn =
    "arn:aws:ecs:us-east-1:123456789012:task/test-sandbox-cluster/repair-old";
  const topologyHandlers: Record<
    string,
    (input: Record<string, never>) => Promise<unknown>
  > = {
    "ecs.list-tasks": async (input) => ({
      taskArns:
        (!state.stopped || state.holdTaskAfterStop) &&
        state.oldTask !== "none" &&
        (state.oldTask !== "live") === (input.desiredStatus === "STOPPED")
          ? [oldArn]
          : [],
    }),
    "ecs.describe-tasks": async () => ({
      failures: [],
      tasks: [
        {
          taskArn: oldArn,
          taskDefinitionArn: previous.taskDefinition,
          lastStatus:
            state.oldTask === "stopped"
              ? "STOPPED"
              : state.oldTask === "deprovisioning"
                ? "DEPROVISIONING"
                : "RUNNING",
          desiredStatus:
            state.oldTask === "live" ? "RUNNING" : state.desiredTaskStatus,
          containers: state.missingContainers
            ? []
            : [
                {
                  name: f.manifest.containerName,
                  lastStatus:
                    state.oldTask === "live"
                      ? "RUNNING"
                      : state.containerStatus,
                  networkInterfaces: [{ privateIpv4Address: "10.0.0.9" }],
                },
              ],
        },
      ],
    }),
    "ecs.get-task-protection": async () => ({
      failures: [],
      protectedTasks: [
        {
          taskArn: oldArn.replace("task/test-sandbox-cluster/", "task/"),
          protectionEnabled: state.protectedTask,
        },
      ],
    }),
    "elbv2.describe-target-health": async (input) => {
      if (
        (state.stopped && !state.holdTaskAfterStop) ||
        input.TargetGroupArn !== f.manifest.targetGroupA
      )
        return providerRead("elbv2", "describe-target-health", input);
      return {
        TargetHealthDescriptions:
          state.foreignTarget || state.oldTask !== "none"
            ? [
                {
                  Target: {
                    Id: state.foreignTarget ? "10.0.0.99" : "10.0.0.9",
                    Port: 3001,
                  },
                  TargetHealth: {
                    State:
                      state.targetState ||
                      (state.oldTask !== "live" ? "draining" : "healthy"),
                  },
                },
              ]
            : [],
      };
    },
  };
  function provider(
    service: string,
    operation: string,
    input: Record<string, never>,
  ) {
    const handler = topologyHandlers[service + "." + operation];
    return handler ? handler(input) : providerRead(service, operation, input);
  }
  async function transact(input: Record<string, never>) {
    if (state.raceReservation && !state.stopped) {
      const control = await f.get("CONTROL");
      control!.coordinatorExpiresAt = 2000;
      await client.send(
        new PutItemCommand({ TableName: f.table, Item: marshall(control) }),
      );
    }
    const completing = JSON.stringify(input).includes('"complete"');
    const lostCompletion = completing ? state.lostCompletion : "";
    if (completing) state.lostCompletion = "";
    if (lostCompletion === "before") throw new Error("completion not applied");
    const out = await f.aws("dynamodb", "transact-write-items", input);
    if (lostCompletion === "after")
      throw new Error("completion acknowledgment lost");
    if (state.lostTransfer && state.stopped)
      throw new Error("transfer acknowledgment lost");
    return out;
  }
  async function updateStage(input: Record<string, never>) {
    const result = await client.send(new UpdateItemCommand(input));
    if (
      unmarshall(input.ExpressionAttributeValues)[":next"] ===
        "stop_submitted" &&
      state.lateTopology
    ) {
      state.oldTask = "live";
      state.protectedTask = state.lateTopology === "protected";
      state.foreignTarget = state.lateTopology === "foreign-target";
    }
    if (
      state.slowIntent &&
      unmarshall(input.ExpressionAttributeValues)[":next"] === "stop_submitted"
    )
      state.seconds += 301;
    return result;
  }
  async function injectCompletionRace(
    service: string,
    operation: string,
    input: Record<string, never>,
  ) {
    if (
      state.raceCompletion &&
      service === "dynamodb" &&
      ["update-item", "transact-write-items"].includes(operation) &&
      JSON.stringify(input).includes('"complete"')
    ) {
      const row = await f.get("REPAIR#" + f.manifest.operationId);
      row!.stage = "foreign";
      await client.send(
        new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
      );
      state.raceCompletion = false;
    }
  }
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, never>,
  ) => {
    calls.push({ service, operation });
    await injectCompletionRace(service, operation, input);
    if (service === "dynamodb" && operation === "get-item") {
      const result = await f.aws(service, operation, input);
      if (
        state.slowTransfer &&
        unmarshall(input.Key).sk.startsWith("REPAIR#") &&
        state.stopped
      )
        state.seconds = 1901;
      return result;
    }
    if (service === "dynamodb" && operation === "update-item")
      return updateStage(input);
    if (service === "dynamodb" && operation === "transact-write-items") {
      return transact(input);
    }
    if (service === "ecs" && operation === "update-service") {
      state.stopped = true;
      if (state.lostStop) throw new Error("stop acknowledgment lost");
      return { service: { serviceName: f.manifest.service, desiredCount: 0 } };
    }
    return provider(service, operation, input);
  };
  const bootstrap = {
    ...f.bootstrap,
    launch: async () => {
      expect(state.holdTaskAfterStop).toBe(false);
      return f.bootstrap.launch();
    },
    promote: async () => {
      const out = await f.bootstrap.promote();
      const row = await f.get("RUNTIME#runtime");
      row!.readiness.observedGeneration = 1;
      await client.send(
        new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
      );
      return out;
    },
  };
  const intro = createIntroduction({
    manifest: f.manifest,
    expectedSha256: f.hash,
    aws,
    bootstrap,
    now: () => state.seconds,
    pause: async () => {
      state.waits++;
      state.holdTaskAfterStop = false;
    },
  });
  return {
    ...f,
    previous,
    previousHash,
    calls,
    repairState: state,
    repairAws: aws,
    intro,
  };
}

test.each(["before", "after"])(
  "repair reconciles completion-only after an uncertain %s acknowledgment",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lostCompletion = kind;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 1 });
    const stops = f.calls.filter(
      (c) => c.operation === "update-service",
    ).length;
    const launches = f.state.updates;
    await expect(
      f.intro.repair(f.previous, f.previousHash),
    ).resolves.toMatchObject({ kind: "complete" });
    expect(await f.get("INTRODUCTION")).toMatchObject({ stage: "complete" });
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: "complete",
    });
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(stops);
    expect(f.state.updates).toBe(launches);
  },
);

test.each(["foreign-lineage", "changed-generation", "stale-runtime"])(
  "completion-only reconciliation refuses %s",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lostCompletion = "before";
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    const sk =
      kind === "foreign-lineage"
        ? "REPAIR#" + f.manifest.operationId
        : kind === "changed-generation"
          ? "CONTROL"
          : "RUNTIME#runtime";
    const row = await f.get(sk);
    if (kind === "foreign-lineage") row!.previousOperationId = randomUUID();
    if (kind === "changed-generation") row!.servingGeneration = 2;
    if (kind === "stale-runtime") row!.readiness.expiresAt = 999;
    await client.send(
      new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
    );
    const writes = f.calls.filter((c) =>
      ["transact-write-items", "update-service"].includes(c.operation),
    ).length;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) =>
        ["transact-write-items", "update-service"].includes(c.operation),
      ),
    ).toHaveLength(writes);
    expect(await f.get("INTRODUCTION")).toMatchObject({
      stage: "routing_acknowledged",
    });
  },
);

test("repair conditionally supersedes an acknowledged failed unserved bootstrap and reuses promotion", async () => {
  const f = await repairFixture();
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  expect(await f.get("BOOTSTRAP#" + f.previous.operationId)).toMatchObject({
    stage: "superseded",
    supersededBy: f.manifest.operationId,
  });
  expect(await f.get("INTRODUCTION")).toMatchObject({
    stage: "complete",
    previousOperationId: f.previous.operationId,
    operationId: f.manifest.operationId,
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "complete",
    previousOperationId: f.previous.operationId,
  });
  expect(await f.get("CONTROL")).toMatchObject({
    servingGeneration: 1,
    coordinatorToken: f.manifest.operationId,
  });
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete" });
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    1,
  );
});

test.each([
  "foreign-owner",
  "serving-member",
  "unacknowledged-launch",
  "live-coordinator",
])("repair refuses %s before writes", async (kind) => {
  const f = await repairFixture();
  const sk =
    kind === "unacknowledged-launch"
      ? "BOOTSTRAP#" + f.previous.operationId
      : "CONTROL";
  const row = await f.get(sk);
  if (kind === "foreign-owner") row!.coordinatorToken = randomUUID();
  if (kind === "serving-member") row!.servingGeneration = 1;
  if (kind === "unacknowledged-launch") row!.stage = "launch_submitted";
  if (kind === "live-coordinator") row!.coordinatorExpiresAt = 2000;
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
  );
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(
    f.calls.some((c) =>
      ["update-service", "transact-write-items"].includes(c.operation),
    ),
  ).toBe(false);
});

test.each(["stop", "transfer"])(
  "repair preserves an unknown %s write and never replays",
  async (kind) => {
    const f = await repairFixture();
    if (kind === "stop") f.repairState.lostStop = true;
    else f.repairState.lostTransfer = true;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(1);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: kind === "stop" ? "stop_submitted" : "initialized",
    });
    expect(f.state.updates).toBe(0);
  },
);

test("repair refuses a future maintenance proof before reserving or stopping", async () => {
  const f = await repairFixture();
  const manifest = {
    ...f.manifest,
    maintenance: {
      ...f.manifest.maintenance,
      confirmedAt: new Date(1001_000).toISOString(),
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const intro = createIntroduction({
    manifest,
    expectedSha256: hash,
    aws: f.repairAws,
    bootstrap: f.bootstrap,
    now: () => 1000,
    pause: async () => undefined,
  });
  await expect(intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(
    f.calls.some((c) =>
      ["update-service", "transact-write-items"].includes(c.operation),
    ),
  ).toBe(false);
});

test("repair reservation condition rejects coordinator changes after its read", async () => {
  const f = await repairFixture();
  f.repairState.raceReservation = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    0,
  );
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toBeUndefined();
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.previous.operationId,
    coordinatorExpiresAt: 2000,
  });
});

test("repair rechecks the stop budget after a slow intent acknowledgment", async () => {
  const f = await repairFixture();
  f.repairState.slowIntent = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    0,
  );
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "stop_submitted",
  });
});

test("repair rechecks maintenance after slow final reads before ownership transfer", async () => {
  const f = await repairFixture();
  f.repairState.slowTransfer = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(
    f.calls.filter((c) => c.operation === "transact-write-items"),
  ).toHaveLength(1);
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.previous.operationId,
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "stop_acknowledged",
  });
});

test("promotion refuses a deadline crossed during final native protection revalidation", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  await f.bootstrap.launch();
  let seconds = 1000;
  const aws = async (
    service: string,
    operation: string,
    input: Record<string, never>,
  ) => {
    const result = await f.aws(service, operation, input);
    if (service === "ecs" && operation === "get-task-protection")
      seconds = 1002;
    return result;
  };
  const bootstrap = createBootstrap({
    manifest: f.manifest,
    expectedSha256: f.hash,
    aws,
    builders,
    types,
    now: () => seconds,
  });
  await expect(bootstrap.promote(1001)).rejects.toThrow();
  expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 0 });
  expect(await f.get("BOOTSTRAP#" + f.manifest.operationId)).toMatchObject({
    stage: "launched",
  });
});

test.each(["protected", "foreign-target"])(
  "repair refuses %s before reservation and shutdown",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.oldTask = "live";
    f.repairState.protectedTask = kind === "protected";
    f.repairState.foreignTarget = kind === "foreign-target";
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.some((c) =>
        ["transact-write-items", "update-service"].includes(c.operation),
      ),
    ).toBe(false);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toBeUndefined();
  },
);

test.each(["live", "stopped"])(
  "repair accounts for exact owned %s task targets",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.oldTask = kind;
    await expect(
      f.intro.repair(f.previous, f.previousHash),
    ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  },
);

test.each(["protected", "foreign-target"])(
  "repair revalidates late %s at the stop boundary",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lateTopology = kind;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(0);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: "stop_submitted",
    });
  },
);

test("repair completion conditions preserve both receipts when ownership changes", async () => {
  const f = await repairFixture();
  f.repairState.raceCompletion = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(await f.get("INTRODUCTION")).toMatchObject({
    stage: "routing_acknowledged",
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "foreign",
  });
  expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 1 });
});

test("repair permits native cleanup only after all containers have stopped", async () => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
});

test.each([
  "running-container",
  "unknown-desired",
  "missing-containers",
  "healthy-target",
])("repair refuses inconsistent cleanup %s before writes", async (kind) => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  if (kind === "running-container") f.repairState.containerStatus = "RUNNING";
  if (kind === "unknown-desired") f.repairState.desiredTaskStatus = "RUNNING";
  if (kind === "missing-containers") f.repairState.missingContainers = true;
  if (kind === "healthy-target") f.repairState.targetState = "healthy";
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(
    f.calls.some((c) =>
      ["transact-write-items", "update-service"].includes(c.operation),
    ),
  ).toBe(false);
});

test("repair waits for exited task cleanup before launching the replacement", async () => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  f.repairState.holdTaskAfterStop = true;
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  expect(f.repairState.waits).toBe(1);
});
