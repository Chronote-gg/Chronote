import { createRuntimeProtectionService } from "../../../src/services/runtimeProtectionService";
import type {
  RuntimeIdentity,
  HistoryTransition,
} from "../../../src/types/deploymentControl";
import type { DeploymentControlRepository } from "../../../src/repositories/deploymentControlRepository";
export function generatedRuntimeProtection(
  identity: RuntimeIdentity,
  now: () => number,
) {
  if (identity.kind !== "ecs")
    throw new Error("Generated ECS identity required");
  let enabled = false;
  return createRuntimeProtectionService({
    identity,
    now,
    onUnsafe: () => {},
    agentUri: "http://generated.invalid",
    request: async (_url, init) => {
      if (init?.body) enabled = JSON.parse(String(init.body)).ProtectionEnabled;
      return new Response(
        JSON.stringify({
          protection: {
            TaskArn: identity.taskArn,
            ProtectionEnabled: enabled,
            ExpirationDate: new Date((now() + 600) * 1000).toISOString(),
          },
        }),
      );
    },
  });
}
export async function completeGeneratedHistory(
  repository: DeploymentControlRepository,
  proof: Pick<
    HistoryTransition,
    | "key"
    | "expectedMeetingId"
    | "expectedOwnerInstanceId"
    | "expectedExecutionVersion"
  >,
  finalPatch: HistoryTransition["patch"] = { status: "complete" },
) {
  expect(
    await repository.transitionMeetingHistory({
      ...proof,
      expectedStatus: "starting",
      patch: { status: "processing" },
    }),
  ).toBe("applied");
  expect(
    await repository.transitionMeetingHistory({
      ...proof,
      expectedStatus: "processing",
      patch: finalPatch,
    }),
  ).toBe("applied");
}
