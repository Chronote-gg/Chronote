import { randomUUID } from "node:crypto";
import { PutItemCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createIntroduction } from "../../scripts/deployment/introduce-sandbox.cjs";
import {
  fixture,
  client,
  bootstrapFor,
  writeIntroduction,
} from "./fixtures/sandboxBootstrap";
type BootstrapFixture = Awaited<ReturnType<typeof fixture>>;
type ProviderResponse = Awaited<ReturnType<BootstrapFixture["aws"]>>;
type CandidateDefinition = Omit<
  Extract<ProviderResponse, { taskDefinition: unknown }>["taskDefinition"],
  "status"
> & { status: string | undefined };

function candidateDefinitionFor(
  f: BootstrapFixture,
  transform: (definition: CandidateDefinition) => CandidateDefinition,
) {
  return bootstrapFor(f, {
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
        return { ...result, taskDefinition: transform(result.taskDefinition) };
      return result;
    },
  });
}

async function expectCandidateLaunchRefused(
  f: BootstrapFixture,
  bootstrap: ReturnType<typeof bootstrapFor>,
) {
  await expect(bootstrap.launch()).rejects.toThrow(
    "Prepared candidate definition mismatch",
  );
  expect(f.state.updates).toBe(0);
  expect((await f.get("BOOTSTRAP#" + f.manifest.operationId))?.stage).toBe(
    "initialized",
  );
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
    bootstrapFor(f, {
      expectedSha256: "0".repeat(64),
    }),
  ).toThrow();
  const wrong = async (s: string, o: string, i: Record<string, never>) =>
    s === "sts"
      ? { Account: "999999999999", Arn: f.manifest.principalArn }
      : f.aws(s, o, i);
  await expect(
    bootstrapFor(f, {
      aws: wrong,
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
    const bootstrap = bootstrapFor(f, {
      aws,
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
  const bootstrap = bootstrapFor(f, {
    aws,
  });
  await expect(bootstrap.launch()).rejects.toThrow();
  expect(f.state.updates).toBe(0);
});

test("launch uses the ECS early-success request contract", async () => {
  const f = await fixture();
  await f.bootstrap.initialize();
  const bootstrap = bootstrapFor(f, {
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
    const bootstrap = bootstrapFor(f, {
      aws: async (
        service: string,
        operation: string,
        input: Record<string, never>,
      ) => {
        const result = await f.aws(service, operation, input);
        if ("Listeners" in result && result.Listeners)
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
    const bootstrap = candidateDefinitionFor(f, (definition) => ({
      ...definition,
      containerDefinitions: definition.containerDefinitions.map(
        (container) => ({
          ...container,
          secrets: [{ name, valueFrom: "generated-secret-reference" }],
        }),
      ),
    }));
    await expectCandidateLaunchRefused(f, bootstrap);
  },
);

test.each(["INACTIVE", "DELETE_IN_PROGRESS", undefined])(
  "unusable candidate definition status %s refuses before claiming launch",
  async (status) => {
    const f = await fixture();
    await f.bootstrap.initialize();
    const bootstrap = candidateDefinitionFor(f, (definition) => ({
      ...definition,
      status,
    }));
    await expectCandidateLaunchRefused(f, bootstrap);
  },
);

test("initialization accepts only the exact acknowledged introduction receipt", async () => {
  const f = await fixture();
  await writeIntroduction(f);
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
  const bootstrap = bootstrapFor(f, {
    aws,
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
  await writeIntroduction(f);
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
  const bootstrap = bootstrapFor(f, {
    aws,
    now: () => seconds,
  });
  await expect(bootstrap.promote(1001)).rejects.toThrow();
  expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 0 });
  expect(await f.get("BOOTSTRAP#" + f.manifest.operationId)).toMatchObject({
    stage: "launched",
  });
});
