import { createRuntimeProtectionService } from "../../../src/services/runtimeProtectionService";
import type { RuntimeIdentity } from "../../../src/types/deploymentControl";

export function localProtection(
  identity: RuntimeIdentity,
  now: () => number,
  expiresAt: number,
) {
  if (identity.kind !== "ecs")
    throw new Error("Protection fixture requires ECS identity");
  return createRuntimeProtectionService({
    identity,
    now,
    onUnsafe: () => {},
    agentUri: "http://synthetic.invalid",
    // Only the transport is simulated. Protection/readiness lifecycle code remains real.
    request: async () =>
      Response.json({
        protection: {
          TaskArn: identity.taskArn,
          ProtectionEnabled: true,
          ExpirationDate: new Date(expiresAt * 1000).toISOString(),
        },
      }),
  });
}
