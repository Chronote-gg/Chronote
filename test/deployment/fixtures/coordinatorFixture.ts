import type {
  GetItemCommandInput,
  UpdateItemCommandInput,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";
import type {
  DescribeTasksCommandInput,
  UpdateServiceCommandInput,
  RegisterTaskDefinitionCommandInput,
} from "@aws-sdk/client-ecs";
import { isDeepStrictEqual } from "node:util";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import * as builders from "../../../src/services/deploymentControlTransactions";
import * as types from "../../../src/types/deploymentControl";
import { createCoordinator } from "../../../scripts/deployment/coordinator.cjs";
export const oldIdentity: Extract<types.RuntimeIdentity, { kind: "ecs" }> = {
  kind: "ecs",
  instanceId: "old",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/fixture/old",
  imageDigest: `sha256:${"b".repeat(64)}`,
  candidateId: "previous",
  protocolVersion: 1,
};
export const candidateIdentity: Extract<
  types.RuntimeIdentity,
  { kind: "ecs" }
> = {
  kind: "ecs",
  instanceId: "new",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/fixture/new",
  imageDigest: `sha256:${"a".repeat(64)}`,
  candidateId: "run-2",
  protocolVersion: 1,
};
export const env = {
  SECRETS_PREFIX: "fixture",
  ECS_CLUSTER: "cluster",
  ECS_SERVICE: "service",
  ECS_TASK_FAMILY: "family",
  DEPLOYMENT_RUN_TOKEN: "run-2",
  DEPLOYMENT_CANDIDATE_ID: "run-2",
  CANDIDATE_IMAGE: `repo@${candidateIdentity.imageDigest}`,
};
export const counts = (recording = 0) => ({
  pending_admission: 0,
  recording,
  finalization: 0,
  personal_processing: 0,
  recovery_processing: 0,
  voice_operation: 0,
  ancillary_delivery: 0,
});
export function fixture() {
  let time = 1000;
  const ctl: types.ControlRecord = {
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "ecs",
    protocolVersion: 1,
    coordinatorToken: "previous",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 0,
    servingGeneration: 1,
    servingMembers: { old: oldIdentity },
  };
  const row = (
    identity: types.RuntimeIdentity,
    role: types.RuntimeRecord["role"],
  ): types.RuntimeRecord => ({
    pk: "ENV",
    sk: `RUNTIME#${identity.instanceId}`,
    recordType: "runtime",
    identity,
    role,
    authorizedGeneration: 1,
    heartbeatAt: time,
    readiness: {
      identity,
      runtimeMode: "all",
      observedEpoch: 1,
      observedGeneration: 1,
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
      provenAt: time,
      expiresAt: time + 30,
    },
    protection: { identity, provenAt: time, expiresAt: time + 600 },
    workCounts: counts(),
  });
  const state = {
    ctl,
    rows: {
      old: row(oldIdentity, "serving"),
      new: row(candidateIdentity, "candidate"),
    } as Record<string, types.RuntimeRecord>,
    launched: false,
    protected: true,
    losePromotionResponse: false,
    loseUpdateResponse: false,
    retirementAcknowledged: false,
    outgoingTask: "running" as "running" | "stopping" | "stopped" | "missing",
    onSleep: () => undefined,
  };
  const definition = {
    taskDefinitionArn: "definition:old",
    family: "family",
    revision: 1,
    taskRoleArn: "task-role",
    executionRoleArn: "execution-role",
    networkMode: "awsvpc",
    volumes: [{ name: "keep" }],
    containerDefinitions: [
      {
        name: "fixture",
        image: "repo:previous",
        environment: [{ name: "DDB_TABLE_PREFIX", value: "fixture-" }],
        secrets: [{ name: "EXAMPLE", valueFrom: "fixture-reference" }],
        logConfiguration: { logDriver: "awslogs" },
      },
    ],
  };
  const svc = {
    loadBalancers: [] as {
      targetGroupArn: string;
      containerName: string;
      containerPort: number;
    }[],
    taskDefinition: "definition:old",
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    deploymentController: { type: "ECS" },
    deploymentConfiguration: {
      alarms: { enable: true, rollback: true, alarmNames: ["fixture"] },
    },
    deployments: [{ rolloutState: "COMPLETED" }],
  };
  const calls: Array<{ operation: string; input: unknown }> = [];
  function refreshProofs() {
    for (const runtime of Object.values(state.rows)) {
      runtime.readiness.observedEpoch = state.ctl.coordinatorEpoch;
      runtime.readiness.observedGeneration = state.ctl.servingGeneration;
      runtime.readiness.expiresAt = time + 30;
      runtime.protection.expiresAt = time + 600;
    }
  }
  function promotion(input: TransactWriteItemsCommandInput) {
    const controlUpdate = input.TransactItems![0].Update!;
    const values = unmarshall(controlUpdate.ExpressionAttributeValues!);
    if (
      values[":token"] !== state.ctl.coordinatorToken ||
      values[":epoch"] !== state.ctl.coordinatorEpoch ||
      values[":generation"] !== state.ctl.servingGeneration ||
      !isDeepStrictEqual(values[":expectedMembers"], state.ctl.servingMembers)
    )
      throw new Error("conditional conflict");
    const runtimeValues = unmarshall(
      input.TransactItems![1].Update!.ExpressionAttributeValues!,
    );
    const selected = state.rows[runtimeValues[":identity"].instanceId];
    if (
      !selected.readiness.dependenciesReady ||
      !selected.readiness.gatewayReady ||
      selected.readiness.expiresAt <= time
    )
      throw new Error("not ready");
    state.ctl.servingGeneration = values[":next"];
    state.ctl.servingMembers = values[":members"];
    selected.role = "serving";
    selected.authorizedGeneration = values[":next"];
    selected.readiness.observedGeneration = values[":next"];
    if (state.losePromotionResponse) {
      state.losePromotionResponse = false;
      throw new Error("response lost after commit");
    }
  }
  function continuation(input: TransactWriteItemsCommandInput) {
    const values = unmarshall(
      input.TransactItems![0].Update!.ExpressionAttributeValues!,
    );
    const item = unmarshall(input.TransactItems![1].Put!.Item!);
    const stored = state.rows[item.identity.instanceId];
    const expected = {
      ...stored,
      role: item.role,
      retirementContinuation: item.retirementContinuation,
    };
    if (
      values[":token"] !== state.ctl.coordinatorToken ||
      values[":epoch"] !== state.ctl.coordinatorEpoch ||
      values[":expiry"] !== state.ctl.coordinatorExpiresAt ||
      !isDeepStrictEqual(values[":deployment"], state.ctl.deployment) ||
      !isDeepStrictEqual(expected, item)
    )
      throw new Error("conditional conflict");
    state.ctl.deployment = values[":complete"];
    state.rows[item.identity.instanceId] = item as types.RuntimeRecord;
  }
  type DynamoInput = GetItemCommandInput &
    UpdateItemCommandInput &
    TransactWriteItemsCommandInput;
  function getItem(input: DynamoInput) {
    const sk = unmarshall(input.Key!).sk;
    const item = sk === "CONTROL" ? state.ctl : state.rows[sk.substring(8)];
    return { Item: item ? marshall(item) : undefined };
  }
  function updateItem(input: DynamoInput) {
    const values = unmarshall(input.ExpressionAttributeValues!);
    if (
      values[":token"] !== state.ctl.coordinatorToken ||
      values[":epoch"] !== state.ctl.coordinatorEpoch ||
      values[":generation"] !== state.ctl.servingGeneration
    )
      throw new Error("conditional conflict");
    for (const [name, field] of Object.entries(
      input.ExpressionAttributeNames!,
    )) {
      Object.assign(state.ctl, {
        [field as string]: values[`:next${name.replace("#field", "")}`],
      });
    }
    return { Attributes: marshall(state.ctl) };
  }
  function retirementRequest(input: DynamoInput) {
    const values = unmarshall(
      input.TransactItems![1].Update!.ExpressionAttributeValues!,
    );
    const runtime = state.rows[values[":identity"].instanceId];
    runtime.retirementRequest = values[":request"];
    if (!state.retirementAcknowledged) return;
    runtime.role = "retired";
    runtime.workCounts = counts();
    runtime.retirementAcknowledgment = {
      request: values[":request"],
      retiredAt: time,
    };
  }
  function transactWrite(input: DynamoInput) {
    if (input.TransactItems![1]?.Put) continuation(input);
    else if (input.TransactItems![0].Update) promotion(input);
    else retirementRequest(input);
    return {};
  }
  const dynamoOperations: Record<string, (input: DynamoInput) => unknown> = {
    "get-item": getItem,
    "update-item": updateItem,
    query: () => ({
      Items: Object.values(state.rows).map((runtime) => marshall(runtime)),
    }),
    "transact-write-items": transactWrite,
  };
  function dynamo(operation: string, raw: unknown) {
    const handler = dynamoOperations[operation];
    if (!handler) throw new Error(`Unexpected AWS operation: ${operation}`);
    return handler(raw as DynamoInput);
  }
  function ecs(operation: string, raw: unknown) {
    const input = raw as DescribeTasksCommandInput &
      UpdateServiceCommandInput &
      RegisterTaskDefinitionCommandInput;
    switch (operation) {
      case "describe-services":
        return { services: [svc] };
      case "validate-update-service":
        return {};
      case "describe-task-definition":
        return { taskDefinition: definition };
      case "list-task-definitions":
        return { taskDefinitionArns: [] };
      case "register-task-definition":
        return {
          taskDefinition: { ...input, taskDefinitionArn: "definition:new" },
        };
      case "list-tasks":
        return {
          taskArns: [
            ...(state.outgoingTask === "running"
              ? ["arn:aws:ecs:us-east-1:123456789012:task/fixture/old"]
              : []),
            ...(state.launched
              ? ["arn:aws:ecs:us-east-1:123456789012:task/fixture/new"]
              : []),
          ],
        };
      case "describe-tasks": {
        const missing = (arn: string) =>
          arn === "arn:aws:ecs:us-east-1:123456789012:task/fixture/old" &&
          state.outgoingTask === "missing";
        return {
          failures: input
            .tasks!.filter(missing)
            .map((arn: string) => ({ arn, reason: "MISSING" })),
          tasks: input
            .tasks!.filter((arn) => !missing(arn))
            .map((arn: string) => ({
              taskArn: arn,
              taskDefinitionArn:
                arn === "arn:aws:ecs:us-east-1:123456789012:task/fixture/old"
                  ? "definition:old"
                  : "definition:new",
              ...(arn ===
                "arn:aws:ecs:us-east-1:123456789012:task/fixture/old" &&
              state.outgoingTask !== "running"
                ? state.outgoingTask === "stopped"
                  ? {
                      lastStatus: "STOPPED",
                      stoppedAt: "2026-10-29T12:00:00.000000+00:00",
                      stoppedReason: "Task failed ELB health checks",
                    }
                  : { lastStatus: "DEACTIVATING" }
                : { lastStatus: "RUNNING" }),
              containers: [
                {
                  imageDigest:
                    arn ===
                    "arn:aws:ecs:us-east-1:123456789012:task/fixture/old"
                      ? oldIdentity.imageDigest
                      : candidateIdentity.imageDigest,
                },
              ],
            })),
        };
      }
      case "get-task-protection":
        return {
          protectedTasks: input.tasks!.map((taskArn: string) => ({
            taskArn,
            protectionEnabled: state.protected,
            expirationDate: new Date((time + 600) * 1000).toISOString(),
          })),
        };
      case "update-service": {
        svc.taskDefinition = input.taskDefinition!;
        Object.assign(svc, {
          deploymentConfiguration: input.deploymentConfiguration,
        });
        state.launched = true;
        refreshProofs();
        if (state.loseUpdateResponse) throw new Error("update response lost");
        return {};
      }
      default:
        throw new Error(`Unexpected ECS operation: ${operation}`);
    }
  }
  const aws = jest.fn(
    async (
      service: string,
      operation: string,
      input: unknown,
    ): Promise<unknown> => {
      calls.push({ operation, input });
      return service === "ecs"
        ? ecs(operation, input)
        : dynamo(operation, input);
    },
  );
  const options = {
    env,
    aws,
    builders,
    types,
    now: () => time,
    sleep: async () => {
      time += 1000;
      refreshProofs();
      state.onSleep();
    },
  };
  const coordinator = createCoordinator(options);
  return {
    state,
    aws,
    calls,
    coordinator,
    definition,
    refreshProofs,
    options,
    svc,
  };
}
