import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeIdentity } from "../types/deploymentControl";
import { RUNTIME_AGENT_TIMEOUT_MS } from "./runtimeProtectionService";

const runtimeInstanceId = process.env.BOT_INSTANCE_ID?.trim() || randomUUID();

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

export async function resolveRuntimeIdentity(
  options: (
    | { kind: "local"; localId: string }
    | { kind: "ecs"; metadataUri: string; candidateId: string }
  ) & { request?: typeof fetch },
): Promise<RuntimeIdentity> {
  if (options.kind === "local") {
    if (!options.localId.trim()) throw new Error("Local identity is required");
    return {
      kind: "local",
      localId: options.localId,
      instanceId: runtimeInstanceId,
      protocolVersion: 1,
    };
  }
  if (!options.metadataUri || !options.candidateId.trim())
    throw new Error("ECS metadata URI and candidate identity are required");
  const request = options.request ?? fetch;
  async function read(url: string): Promise<unknown> {
    const response = await request(url, {
      signal: AbortSignal.timeout(RUNTIME_AGENT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("ECS metadata request failed");
    return response.json();
  }
  const uri = options.metadataUri.replace(/\/$/, "");
  const container = containerMetadata.parse(await read(uri));
  const task = taskMetadata.parse(await read(`${uri}/task`));
  const current = task.Containers.find(
    (item) => item.DockerId === container.DockerId,
  );
  if (!current || current.ImageID !== container.ImageID)
    throw new Error("ECS container identity mismatch");
  return {
    kind: "ecs",
    instanceId: runtimeInstanceId,
    taskArn: task.TaskARN,
    imageDigest: container.ImageID,
    candidateId: options.candidateId,
    protocolVersion: 1,
  };
}
