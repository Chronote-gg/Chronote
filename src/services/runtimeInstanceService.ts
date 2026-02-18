import { randomUUID } from "node:crypto";

const runtimeInstanceId =
  process.env.BOT_INSTANCE_ID?.trim() ||
  process.env.HOSTNAME?.trim() ||
  randomUUID();

export function getRuntimeInstanceId(): string {
  return runtimeInstanceId;
}
