import type {
  ConditionalResult,
  DeploymentControlRepository,
} from "../../src/repositories/deploymentControlRepository";

type SuppressionWrite = Parameters<
  DeploymentControlRepository["writeSuppression"]
>[0];

/** Sends each suppression write in order and checks that each one lands or is refused as stale, as listed. */
export async function expectSuppressionWriteOutcomes(
  repository: Pick<DeploymentControlRepository, "writeSuppression">,
  writes: Array<[SuppressionWrite, ConditionalResult]>,
) {
  for (const [write, outcome] of writes)
    expect(await repository.writeSuppression(write)).toBe(outcome);
}
