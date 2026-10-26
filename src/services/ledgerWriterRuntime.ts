import { z } from "zod";
import {
  ledgerWriterRuntimeSchema,
  type LedgerWriterRuntime,
} from "../types/ledgerWriterRuntime";
const containerSchema = z.object({
  DockerId: z.string().min(1),
  ImageID: ledgerWriterRuntimeSchema.shape.imageDigest,
});
const taskSchema = z.object({
  TaskARN: ledgerWriterRuntimeSchema.shape.taskArn,
  Containers: z.array(containerSchema),
});
export async function readLedgerWriterRuntime(
  uri: string | undefined,
): Promise<LedgerWriterRuntime | undefined> {
  if (!uri) return undefined;
  try {
    const url = new URL(uri);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "169.254.170.2" ||
      !url.pathname.startsWith("/v4/") ||
      url.search ||
      url.hash
    )
      return undefined;
    const base = url.href.replace(/\/$/, "");
    const [containerResponse, taskResponse] = await Promise.all([
      fetch(base, { signal: AbortSignal.timeout(1500), redirect: "error" }),
      fetch(base + "/task", {
        signal: AbortSignal.timeout(1500),
        redirect: "error",
      }),
    ]);
    if (!containerResponse.ok || !taskResponse.ok) return undefined;
    const container = containerSchema.parse(await containerResponse.json());
    const task = taskSchema.parse(await taskResponse.json());
    if (
      !task.Containers.some(
        (item) =>
          item.DockerId === container.DockerId &&
          item.ImageID === container.ImageID,
      )
    )
      return undefined;
    return { taskArn: task.TaskARN, imageDigest: container.ImageID };
  } catch {
    return undefined;
  }
}
