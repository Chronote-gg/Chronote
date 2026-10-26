import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import { DeploymentControlError } from "../repositories/deploymentControlRepository";
import { ZodError } from "zod";
import {
  sameRuntimeIdentity,
  type RuntimeIdentity,
  type RuntimeRecord,
} from "../types/deploymentControl";

async function requireLocal(
  repository: DeploymentControlRepository,
  identity: RuntimeIdentity,
) {
  if (identity.kind !== "local" || !(await repository.supportsLocalBootstrap()))
    throw new Error(
      "Local bootstrap requires a local identity and explicit mock or loopback DynamoDB storage",
    );
}
async function readLocalControl(repository: DeploymentControlRepository) {
  const control = await repository
    .getRecord("ENV", "CONTROL")
    .catch((error) => {
      if (error instanceof ZodError)
        throw new Error(
          "Existing Control is unmarked or invalid; use a separate local table prefix or migrate it explicitly",
        );
      throw error;
    });
  if (
    control?.recordType !== "control" ||
    control.runtimeEnvironment !== "local"
  )
    throw new Error(
      "Existing Control is not explicitly local; use a separate local table prefix or migrate it explicitly",
    );
  return control;
}
export async function initializeLocalControl(
  repository: DeploymentControlRepository,
  identity: RuntimeIdentity,
  now: number,
) {
  await requireLocal(repository, identity);
  await repository.initializeControl({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment: "local",
    protocolVersion: 1,
    coordinatorToken: identity.instanceId,
    coordinatorEpoch: 0,
    coordinatorExpiresAt: now + 900,
    servingGeneration: 0,
    servingMembers: {},
  });
  return readLocalControl(repository);
}
/** Three CAS attempts bound contention; a fresh conflicting owner is refused immediately. */
export async function bootstrapLocalRuntime(
  repository: DeploymentControlRepository,
  identity: RuntimeIdentity,
  refresh: () => Promise<unknown>,
  now: () => number,
) {
  await requireLocal(repository, identity);
  for (let attempt = 0; attempt < 3; attempt++) {
    await refresh();
    const control = await readLocalControl(repository);
    const candidate = await repository.getRecord(
      "ENV",
      `RUNTIME#${identity.instanceId}`,
    );
    if (
      candidate?.recordType !== "runtime" ||
      !sameRuntimeIdentity(candidate.identity, identity)
    )
      throw new Error("Local candidate missing");
    const members: RuntimeRecord[] = [];
    for (const member of Object.values(control.servingMembers)) {
      const row = await repository.getRecord(
        "ENV",
        `RUNTIME#${member.instanceId}`,
      );
      if (row?.recordType !== "runtime")
        throw new Error(
          "Local member missing; repair local control explicitly",
        );
      members.push(row);
    }
    try {
      if (
        (await repository.bootstrapLocal({
          control,
          candidate,
          members,
          now: now(),
        })) === "applied"
      )
        return;
    } catch (error) {
      if (
        !(error instanceof DeploymentControlError) ||
        error.kind !== "conflict"
      )
        throw error;
    }
  }
  throw new Error(
    "Local bootstrap changed during three attempts; retry startup",
  );
}
