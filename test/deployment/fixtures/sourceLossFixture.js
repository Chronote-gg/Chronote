import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { routingFixture } from "./routingFixture";
export async function sourceLossFixture() {
  const f = routingFixture();
  await f.coordinator.prepare();
  f.svc.serviceName = "service";
  f.svc.runningCount = 1;
  f.traffic.sourceTargets = [];
  const role = "arn:aws:iam::123456789012:role/fixture-sandbox-github-deploy";
  const session = "chronote-sandbox-900-1";
  const state = {
    receipt: undefined,
    sourceStatus: "STOPPED",
    missing: false,
    extra: false,
    clock: 1000,
    refresh: true,
    loseAck: false,
    beforeWrite: () => undefined,
    afterWrite: () => undefined,
  };
  const original = f.aws.getMockImplementation();
  function transact(input) {
    f.calls.push({ operation: "transact-write-items", input });
    state.beforeWrite(input);
    const update = input.TransactItems[0].Update;
    const values = unmarshall(update.ExpressionAttributeValues);
    const expectedMembers = values[":expectedMembers"] ?? values[":members"];
    if (
      values[":token"] !== f.state.ctl.coordinatorToken ||
      values[":epoch"] !== f.state.ctl.coordinatorEpoch ||
      values[":generation"] !== f.state.ctl.servingGeneration ||
      !isDeepStrictEqual(expectedMembers, f.state.ctl.servingMembers) ||
      !isDeepStrictEqual(values[":deployment"], f.state.ctl.deployment)
    )
      throw new Error("conditional conflict");
    const put = input.TransactItems.find((item) => item.Put).Put;
    const receipt = unmarshall(put.Item);
    if (
      state.receipt
        ? receipt.stage === "admission_transferred"
        : receipt.stage !== "admission_transferred"
    )
      throw new Error("receipt conflict");
    if (values[":next"] !== undefined) {
      const row = f.state.rows.new;
      if (!row.readiness.dependenciesReady || row.role !== "candidate")
        throw new Error("candidate conflict");
      f.state.ctl.servingGeneration = values[":next"];
      f.state.ctl.servingMembers = values[":members"];
      row.role = "serving";
      row.authorizedGeneration = values[":next"];
      row.readiness.observedGeneration = values[":next"];
    }
    f.state.ctl.deployment =
      values[":deploymentNext"] ?? values[":nextDeployment"];
    f.state.ctl.coordinatorExpiresAt =
      values[":expiryNext"] ?? values[":nextExpiry"];
    state.receipt = receipt;
    state.afterWrite(receipt);
    if (state.loseAck) throw new Error("lost acknowledgment after commit");
    return {};
  }
  async function describeTasks(service, operation, input) {
    const response = await original(service, operation, input);
    for (const task of response.tasks) {
      task.group = "service:service";
      task.desiredStatus = "RUNNING";
      if (task.taskArn === f.oldIdentity.taskArn) {
        task.lastStatus = state.sourceStatus;
        task.desiredStatus = state.sourceStatus;
        task.stoppedAt = new Date(999000).toISOString();
      }
    }
    if (state.missing && input.tasks.includes(f.oldIdentity.taskArn)) {
      response.tasks = response.tasks.filter(
        (task) => task.taskArn !== f.oldIdentity.taskArn,
      );
      response.failures = [{ arn: f.oldIdentity.taskArn, reason: "MISSING" }];
    }
    return response;
  }
  f.aws.mockImplementation(async (service, operation, input) => {
    if (service === "sts")
      return {
        Account: "123456789012",
        Arn:
          role.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/") +
          "/" +
          session,
      };
    if (
      service === "dynamodb" &&
      operation === "get-item" &&
      unmarshall(input.Key).pk.startsWith("SOURCELOSS#")
    )
      return { Item: state.receipt ? marshall(state.receipt) : undefined };
    if (operation === "describe-task-definition")
      return {
        taskDefinition: {
          ...f.definition,
          taskDefinitionArn: "definition:new",
          containerDefinitions: [
            {
              ...f.definition.containerDefinitions[0],
              image: f.options.env.CANDIDATE_IMAGE,
              environment: [
                ...f.definition.containerDefinitions[0].environment,
                { name: "STRIPE_MODE", value: "test" },
              ],
            },
          ],
        },
      };
    if (operation === "scan") return { Items: [] };
    if (operation === "list-tasks")
      return {
        taskArns: [
          f.candidateIdentity.taskArn,
          ...(state.extra ? [f.oldIdentity.taskArn] : []),
        ],
      };
    if (operation === "describe-tasks")
      return describeTasks(service, operation, input);
    if (service === "dynamodb" && operation === "transact-write-items")
      return transact(input);
    return original(service, operation, input);
  });
  const options = {
    ...f.options,
    env: {
      ...f.options.env,
      AWS_REGION: "us-east-1",
      EXPECTED_ACCOUNT_ID: "123456789012",
      EXPECTED_ROLE_ARN: role,
      EXPECTED_SESSION_NAME: session,
    },
    validateScope: () => undefined,
    now: () => state.clock,
    sleep: async () => {
      state.clock++;
      if (state.refresh) {
        f.state.rows.new.heartbeatAt = state.clock;
        f.state.rows.new.readiness.provenAt = state.clock;
        f.state.rows.new.readiness.expiresAt = state.clock + 30;
      }
    },
  };
  return { ...f, loss: state, options, before: f.calls.length };
}
