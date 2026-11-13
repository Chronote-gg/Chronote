import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./configService";
import { RUNTIME_AGENT_TIMEOUT_MS } from "./lifecycleTiming";

// On ECS every task gets its own id: a BOT_INSTANCE_ID set in the task definition would be shared by all of them.
const runtimeInstanceId = config.runtime.metadataUri
  ? randomUUID()
  : process.env.BOT_INSTANCE_ID?.trim() || randomUUID();

export function getRuntimeInstanceId(): string {
  return runtimeInstanceId;
}

const containerMetadata = z.object({
  DockerId: z.string().min(1),
  ImageID: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const taskMetadata = z.object({
  TaskARN: z.string().regex(/^arn:[^:]+:ecs:[^:]+:\d{12}:task\//),
  Containers: z.array(containerMetadata),
});
// The task definition revision orders releases, so the registry refuses a task without a numeric one.
const workerTaskMetadata = taskMetadata.extend({
  Revision: z.string().regex(/^\d+$/),
});

async function readMetadata(
  url: string,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request(url, {
    signal: AbortSignal.timeout(RUNTIME_AGENT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("ECS metadata request failed");
  return response.json();
}

export type WorkerIdentity = {
  instanceId: string;
  release: number;
  taskArn?: string;
};

export async function resolveWorkerIdentity(
  request: typeof fetch = fetch,
): Promise<WorkerIdentity> {
  const metadataUri = config.runtime.metadataUri.replace(/\/$/, "");
  if (!metadataUri)
    return { instanceId: runtimeInstanceId, release: config.runtime.release };
  const task = workerTaskMetadata.parse(
    await readMetadata(`${metadataUri}/task`, request),
  );
  return {
    instanceId: runtimeInstanceId,
    release: Number(task.Revision),
    taskArn: task.TaskARN,
  };
}

let processIdentity: Promise<WorkerIdentity> | undefined;
/** Resolved once per process, so the registry and every receipt name the same worker and release. */
export function getWorkerIdentity(): Promise<WorkerIdentity> {
  processIdentity ??= resolveWorkerIdentity();
  return processIdentity;
}
