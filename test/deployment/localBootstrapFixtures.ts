import type {
  ControlRecord,
  RuntimeRecord,
} from "../../src/types/deploymentControl";
import { control, runtime } from "./controlFixtures";

export function localRuntime(
  instanceId: string,
  mode: "bot" | "api" | "all" = "all",
): RuntimeRecord {
  const row = runtime(instanceId, "candidate");
  const identity = {
    kind: "local" as const,
    instanceId,
    localId: instanceId,
    protocolVersion: 1 as const,
  };
  return {
    ...row,
    identity,
    readiness: {
      ...row.readiness,
      identity,
      runtimeMode: mode,
      gatewayReady: mode !== "api",
    },
    protection: { ...row.protection, identity },
  };
}
export function localControl(members: RuntimeRecord[] = []): ControlRecord {
  return {
    ...control,
    runtimeEnvironment: "local",
    servingMembers: Object.fromEntries(
      members.map((row) => [row.identity.instanceId, row.identity]),
    ),
  };
}
