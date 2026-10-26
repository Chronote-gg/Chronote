import { sourceLossFixture } from "./sourceLossFixture";
import { continuationBinding } from "../../../scripts/deployment/continue-sandbox.cjs";
import { terminalPacketSha256 } from "../../../scripts/deployment/retained-stop-proof.cjs";
export async function retainedSourceLossFixture() {
  const f = await sourceLossFixture();
  f.options.env.ECS_CLUSTER = "fixture";
  f.state.ctl.deployment.cluster = "fixture";
  const clusterArn = "arn:aws:ecs:us-east-1:123456789012:cluster/fixture";
  const original = f.aws.getMockImplementation();
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    if (operation === "describe-tasks")
      for (const task of result.tasks) {
        task.clusterArn = clusterArn;
        task.version = 7;
        if (task.taskArn === f.oldIdentity.taskArn) {
          task.containers[0].lastStatus = "STOPPED";
          task.containers[0].exitCode = 0;
        }
      }
    return result;
  });
  const response = await f.aws("ecs", "describe-tasks", {
    tasks: [f.oldIdentity.taskArn],
  });
  const task = response.tasks[0];
  const packet = {
    version: 1,
    kind: "operator_retained_ecs_stop",
    accountId: "123456789012",
    region: "us-east-1",
    capturedAt: new Date(999500).toISOString(),
    originalSnapshotSha256: "c".repeat(64),
    provenance: "operator_captured_provider_response",
    operationBinding: continuationBinding(f.state.ctl, f.candidateIdentity),
    sourceTask: {
      taskArn: task.taskArn,
      clusterArn,
      taskDefinitionArn: task.taskDefinitionArn,
      group: task.group,
      lastStatus: task.lastStatus,
      desiredStatus: task.desiredStatus,
      stoppedAt: task.stoppedAt,
      version: 7,
      containers: [
        {
          name: task.containers[0].name,
          imageDigest: task.containers[0].imageDigest,
          lastStatus: "STOPPED",
          exitCode: 0,
        },
      ],
    },
  };
  function bindPacket() {
    f.options.env.SOURCE_LOSS_TERMINAL_PROOF_JSON = JSON.stringify(packet);
    f.options.env.SOURCE_LOSS_TERMINAL_PROOF_SHA256 =
      terminalPacketSha256(packet);
  }
  bindPacket();
  return { ...f, packet, bindPacket };
}
