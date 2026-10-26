/** @jest-environment node */
import { ECSClient } from "@aws-sdk/client-ecs";
import { verifyLedgerWriterDeployment } from "../../src/services/ledgerWriterDeployment";
const clusterArn = "arn:aws:ecs:us-east-1:123456789012:cluster/test";
const serviceArn = "arn:aws:ecs:us-east-1:123456789012:service/test/api";
const taskDefinitionArn =
  "arn:aws:ecs:us-east-1:123456789012:task-definition/api:2";
const imageDigest = "sha256:" + "a".repeat(64);
const taskArn = "arn:aws:ecs:us-east-1:123456789012:task/test/task-one";
const service = {
  serviceArn,
  serviceName: "api",
  clusterArn,
  status: "ACTIVE",
  taskDefinition: taskDefinitionArn,
  desiredCount: 1,
  runningCount: 1,
  pendingCount: 0,
  deployments: [
    {
      status: "PRIMARY",
      taskDefinition: taskDefinitionArn,
      rolloutState: "COMPLETED",
    },
  ],
};
const task = {
  taskArn,
  clusterArn,
  lastStatus: "RUNNING",
  desiredStatus: "RUNNING",
  taskDefinitionArn,
  containers: [{ name: "api", imageDigest, lastStatus: "RUNNING" }],
};
function fixture() {
  const ecs = new ECSClient({ region: "us-east-1" });
  const send = jest
    .spyOn(ecs, "send")
    .mockResolvedValueOnce({ services: [service] } as never)
    .mockResolvedValueOnce({ taskArns: [taskArn] } as never)
    .mockResolvedValueOnce({ tasks: [task] } as never)
    .mockResolvedValueOnce({ services: [service] } as never);
  return { ecs, send };
}
const target = { clusterArn, serviceArn, containerName: "api", imageDigest };
afterEach(() => jest.restoreAllMocks());
test("verifies every API writer and the sample writer task at the expected immutable image", async () => {
  const f = fixture();
  expect(
    await verifyLedgerWriterDeployment(f.ecs, target, { taskArn, imageDigest }),
  ).toMatchObject({
    clusterArn,
    serviceArn,
    taskDefinitionArn,
    imageDigest,
    taskArns: [taskArn],
  });
});
test("sample task must belong to the selected writer service", async () => {
  const f = fixture();
  await expect(
    verifyLedgerWriterDeployment(f.ecs, target, {
      taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/foreign-task",
      imageDigest,
    }),
  ).rejects.toThrow();
});
test("rollout or pending tasks prevent a deployment boundary", async () => {
  const f = fixture();
  f.send.mockReset().mockResolvedValueOnce({
    services: [{ ...service, pendingCount: 1 }],
  } as never);
  await expect(
    verifyLedgerWriterDeployment(f.ecs, target, { taskArn, imageDigest }),
  ).rejects.toThrow();
});
test("a different deployed image cannot satisfy expected ledger writer proof", async () => {
  const f = fixture();
  f.send
    .mockReset()
    .mockResolvedValueOnce({ services: [service] } as never)
    .mockResolvedValueOnce({ taskArns: [taskArn] } as never)
    .mockResolvedValueOnce({
      tasks: [
        {
          ...task,
          containers: [
            {
              name: "api",
              imageDigest: "sha256:" + "b".repeat(64),
              lastStatus: "RUNNING",
            },
          ],
        },
      ],
    } as never);
  await expect(
    verifyLedgerWriterDeployment(f.ecs, target, { taskArn, imageDigest }),
  ).rejects.toThrow();
});
test("a service changing after task enumeration cannot publish stale readiness", async () => {
  const f = fixture();
  f.send
    .mockReset()
    .mockResolvedValueOnce({ services: [service] } as never)
    .mockResolvedValueOnce({ taskArns: [taskArn] } as never)
    .mockResolvedValueOnce({ tasks: [task] } as never)
    .mockResolvedValueOnce({
      services: [
        {
          ...service,
          taskDefinition: taskDefinitionArn + "1",
          deployments: service.deployments.map((deployment) => ({
            ...deployment,
            taskDefinition: taskDefinitionArn + "1",
          })),
        },
      ],
    } as never);
  await expect(
    verifyLedgerWriterDeployment(f.ecs, target, { taskArn, imageDigest }),
  ).rejects.toThrow();
});
