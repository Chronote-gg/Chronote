import { randomUUID, createHash } from "node:crypto";
import { PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createIntroduction } from "../../../scripts/deployment/introduce-sandbox.cjs";
import { fixture, client } from "./sandboxBootstrap";
export async function repairFixture() {
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
