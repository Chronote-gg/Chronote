import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { carryforwardFixture } from "./carryforwardFixture";
import { carryforwardSandbox } from "../../../scripts/deployment/carryforward-sandbox.cjs";
import { controlAuthority } from "../../../scripts/deployment/carryforward-state.cjs";
import { bindingHash } from "../../../scripts/deployment/binding-hash.cjs";
import { taskDefinitionInput } from "../../../scripts/deployment/task-definition.cjs";

export async function preparingRecoveryFixture() {
  const f = carryforwardFixture();
  const inspected = await carryforwardSandbox({
    ...f.options,
    mode: "inspect",
  });
  f.options.env.CARRYFORWARD_BINDING_SHA256 = inspected.bindingSha256;
  const original = f.aws.getMockImplementation();
  let failed = false;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (
      operation === "update-item" &&
      unmarshall(input.ExpressionAttributeValues)[":next3"]?.taskDefinition
    ) {
      failed = true;
      throw new Error("definition acknowledgment refused");
    }
    const result = await original(service, operation, input);
    if (operation === "register-task-definition") {
      f.carry.registered.containerDefinitions[0].environment.reverse();
      Object.assign(f.carry.registered, {
        registeredBy: f.carry.archive.actorArn,
        registeredAt: new Date(f.options.now() * 1000).toISOString(),
        status: "ACTIVE",
      });
    }
    return result;
  });
  await carryforwardSandbox({ ...f.options, mode: "carryforward" }).catch(
    () => undefined,
  );
  if (!failed || !f.carry.registered || f.state.ctl.deployment.taskDefinition)
    throw Error("fixture must preserve failed preparing registration");
  f.aws.mockImplementation(original);
  f.carry.advance(181);
  await f.options.sleep();
  const archive = JSON.parse(JSON.stringify(f.carry.archive)),
    recovery = JSON.parse(JSON.stringify(f.carry.recovery));
  const recoveryState = {
    receipt: undefined,
    loseAck: false,
    beforeClaim: () => undefined,
    afterClaim: () => undefined,
  };
  const runProof = {
    id: 901,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    status: "completed",
    conclusion: "failure",
    path: ".github/workflows/sandbox-identity.yml",
    run_started_at: new Date(900000).toISOString(),
    updated_at: new Date(1100000).toISOString(),
  };
  Object.assign(f.options.env, {
    GITHUB_RUN_ID: "902",
    GITHUB_SHA: "c".repeat(40),
    EXPECTED_SESSION_NAME: "chronote-sandbox-902-1",
  });
  const proof = {
    version: 1,
    kind: "sandbox_preparing_recovery",
    operationId: f.manifest.operationId,
    sourceCommit: f.options.env.GITHUB_SHA,
    originalManifestSha256: f.options.env.CARRYFORWARD_MANIFEST_SHA256,
    controlSha256: bindingHash(controlAuthority(f.state.ctl)),
    archiveSha256: bindingHash(archive),
    recoverySha256: bindingHash(recovery),
    logicalRunToken: "901-1",
    definitionArn: "definition:new",
    definitionSha256: bindingHash(taskDefinitionInput(f.carry.registered)),
    approveBefore: f.options.now() + 2000,
  };
  function bindProof() {
    f.options.env.PREPARING_RECOVERY_PROOF_JSON = JSON.stringify(proof);
    f.options.env.PREPARING_RECOVERY_PROOF_SHA256 = bindingHash(proof);
  }
  bindProof();
  f.options.originalExecution = async () => runProof;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "list-task-definitions")
      return { taskDefinitionArns: ["definition:new"] };
    if (
      operation === "get-item" &&
      unmarshall(input.Key).sk === "PREPARING_RECOVERY"
    )
      return {
        Item: recoveryState.receipt
          ? marshall(recoveryState.receipt)
          : undefined,
      };
    if (
      operation === "transact-write-items" &&
      input.TransactItems[1]?.Put &&
      unmarshall(input.TransactItems[1].Put.Item).sk === "PREPARING_RECOVERY"
    ) {
      recoveryState.beforeClaim();
      if (recoveryState.receipt) throw Error("recovery already consumed");
      const values = unmarshall(
        input.TransactItems[0].Update.ExpressionAttributeValues,
      );
      Object.assign(f.state.ctl, {
        coordinatorEpoch: values[":nextEpoch"],
        coordinatorExpiresAt: values[":nextExpiry"],
        deployment: values[":nextDeployment"],
      });
      recoveryState.receipt = unmarshall(input.TransactItems[1].Put.Item);
      recoveryState.afterClaim();
      if (recoveryState.loseAck) throw Error("lost recovery response");
      return {};
    }
    return original(service, operation, input);
  });
  return {
    ...f,
    proof,
    bindProof,
    archive,
    recovery,
    recoveryState,
    runProof,
    before: f.calls.length,
  };
}
