import {
  ECSClient,
  type Task,
  DescribeServicesCommand,
  ListTasksCommand,
  DescribeTasksCommand,
} from "@aws-sdk/client-ecs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  ledgerWriterRuntimeSchema,
  type LedgerWriterRuntime,
} from "../types/ledgerWriterRuntime";
import {
  ledgerWriterDeploymentTargetSchema,
  type LedgerWriterDeploymentTarget,
  type LedgerWriterDeployment,
} from "../types/ledgerWriterDeployment";
export {
  ledgerWriterDeploymentTargetSchema,
  ledgerWriterDeploymentSchema,
  type LedgerWriterDeploymentTarget,
  type LedgerWriterDeployment,
} from "../types/ledgerWriterDeployment";
const serviceSchema = z.object({
  serviceArn: z.string().min(1),
  serviceName: z.string().min(1),
  clusterArn: z.string().min(1),
  status: z.literal("ACTIVE"),
  taskDefinition: z.string().min(1),
  desiredCount: z.number().int().positive(),
  runningCount: z.number().int().positive(),
  pendingCount: z.literal(0),
  deployments: z
    .array(
      z.object({
        status: z.literal("PRIMARY"),
        taskDefinition: z.string().min(1),
        rolloutState: z.literal("COMPLETED"),
      }),
    )
    .length(1),
});
export async function verifyLedgerWriterDeployment(
  ecs: ECSClient,
  input: LedgerWriterDeploymentTarget,
  witness?: LedgerWriterRuntime,
): Promise<LedgerWriterDeployment> {
  const target = ledgerWriterDeploymentTargetSchema.parse(input);
  if (
    witness &&
    ledgerWriterRuntimeSchema.parse(witness).imageDigest !== target.imageDigest
  )
    throw mismatch();
  const before = await stableService(ecs, target);
  const taskArns = await runningTaskArns(ecs, target, before.serviceName);
  if (
    taskArns.length !== before.runningCount ||
    (witness && !taskArns.includes(witness.taskArn))
  )
    throw mismatch();
  for (let start = 0; start < taskArns.length; start += 100) {
    const expected = taskArns.slice(start, start + 100);
    const result = await ecs.send(
      new DescribeTasksCommand({ cluster: target.clusterArn, tasks: expected }),
    );
    if (result.failures?.length || result.tasks?.length !== expected.length)
      throw mismatch();
    const seen = new Set<string>();
    for (const task of result.tasks)
      verifyWriterTask(task, expected, seen, target, before.taskDefinition);
  }
  const after = await stableService(ecs, target);
  if (!isDeepStrictEqual(before, after)) throw mismatch();
  return {
    ...target,
    taskDefinitionArn: before.taskDefinition,
    taskArns: taskArns.sort(),
  };
}
function verifyWriterTask(
  task: Task,
  expected: string[],
  seen: Set<string>,
  target: LedgerWriterDeploymentTarget,
  taskDefinition: string,
) {
  if (
    !task.taskArn ||
    seen.has(task.taskArn) ||
    !expected.includes(task.taskArn) ||
    task.clusterArn !== target.clusterArn ||
    task.lastStatus !== "RUNNING" ||
    task.desiredStatus !== "RUNNING" ||
    task.taskDefinitionArn !== taskDefinition
  )
    throw mismatch();
  seen.add(task.taskArn);
  const containers = task.containers?.filter(
    (container) => container.name === target.containerName,
  );
  if (
    containers?.length !== 1 ||
    containers[0].imageDigest !== target.imageDigest ||
    containers[0].lastStatus !== "RUNNING"
  )
    throw mismatch();
}

const mismatch = () =>
  new Error(
    "Normal ledger writer deployment is not stable or does not match its witness",
  );
async function stableService(
  ecs: ECSClient,
  target: LedgerWriterDeploymentTarget,
) {
  const result = await ecs.send(
    new DescribeServicesCommand({
      cluster: target.clusterArn,
      services: [target.serviceArn],
    }),
  );
  if (result.failures?.length || result.services?.length !== 1)
    throw mismatch();
  const service = serviceSchema.parse(result.services[0]);
  if (
    service.clusterArn !== target.clusterArn ||
    service.serviceArn !== target.serviceArn ||
    service.runningCount !== service.desiredCount ||
    service.deployments[0].taskDefinition !== service.taskDefinition
  )
    throw mismatch();
  return service;
}
async function runningTaskArns(
  ecs: ECSClient,
  target: LedgerWriterDeploymentTarget,
  serviceName: string,
): Promise<string[]> {
  const tasks = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await ecs.send(
      new ListTasksCommand({
        cluster: target.clusterArn,
        serviceName,
        desiredStatus: "RUNNING",
        maxResults: 100,
        ...(token ? { nextToken: token } : {}),
      }),
    );
    for (const arn of page.taskArns ?? []) {
      if (!arn || tasks.has(arn)) throw mismatch();
      tasks.add(arn);
    }
    if (!page.nextToken) return [...tasks];
    if (tokens.has(page.nextToken)) throw mismatch();
    tokens.add(page.nextToken);
    token = page.nextToken;
  }
  throw mismatch();
}
