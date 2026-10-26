/** @jest-environment node */
import {
  createMockDeploymentControlRepository,
  createDynamoDeploymentControlRepository,
} from "../../src/repositories/deploymentControlRepository";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  bootstrapLocalRuntime,
  initializeLocalControl,
} from "../../src/services/runtimeLocalBootstrapService";
import { createRuntimeLifecycle } from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import {
  localControl,
  localRuntime,
} from "../deployment/localBootstrapFixtures";
import { control, runtime } from "../deployment/controlFixtures";
import type { RuntimeRecord } from "../../src/types/deploymentControl";

async function fixture(members: RuntimeRecord[] = []) {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(localControl(members));
  for (const row of members) await repository.writeRuntime(row);
  const candidate = localRuntime("restart", "bot");
  await repository.writeRuntime(candidate);
  return { repository, candidate };
}
test("persistent expired local restart seals old generation and retains fresh API", async () => {
  const old = { ...localRuntime("old", "bot"), role: "serving" as const };
  old.readiness.expiresAt = 100;
  const api = { ...localRuntime("api", "api"), role: "serving" as const };
  const { repository, candidate } = await fixture([old, api]);
  await bootstrapLocalRuntime(
    repository,
    candidate.identity,
    async () => undefined,
    () => 100,
  );
  expect(await repository.getRecord("ENV", "CONTROL")).toMatchObject({
    coordinatorEpoch: 4,
    servingGeneration: 8,
    servingMembers: { restart: candidate.identity, api: api.identity },
  });
  expect(
    await repository.checkAdmission({
      instanceId: "old",
      identity: old.identity,
      protocolVersion: 1,
      authorizedGeneration: 7,
      observedEpoch: 3,
      now: 100,
    }),
  ).toMatchObject({ kind: "blocked" });
  expect(
    await repository.checkAdmission({
      instanceId: "api",
      identity: api.identity,
      protocolVersion: 1,
      authorizedGeneration: 8,
      observedEpoch: 4,
      now: 100,
    }),
  ).toMatchObject({ kind: "admitted" });
});
test("fresh same-mode and all-mode owners cannot be displaced", async () => {
  for (const mode of ["bot", "all"] as const) {
    const old = { ...localRuntime("old", mode), role: "serving" as const };
    const { repository, candidate } = await fixture([old]);
    await expect(
      bootstrapLocalRuntime(
        repository,
        candidate.identity,
        async () => undefined,
        () => 100,
      ),
    ).rejects.toThrow("Fresh local owner");
    expect(await repository.getRecord("ENV", "CONTROL")).toEqual(
      localControl([old]),
    );
  }
});
test("concurrent same-mode candidates select one owner through CAS", async () => {
  const { repository, candidate } = await fixture();
  const other = localRuntime("other", "bot");
  await repository.writeRuntime(other);
  const results = await Promise.allSettled(
    [candidate, other].map((row) =>
      bootstrapLocalRuntime(
        repository,
        row.identity,
        async () => undefined,
        () => 100,
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const stored = await repository.getRecord("ENV", "CONTROL");
  expect(
    stored?.recordType === "control" && Object.keys(stored.servingMembers),
  ).toHaveLength(1);
});
test("ECS control and identity and remote storage are refused before bootstrap writes", async () => {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({ ...control, servingMembers: {} });
  const candidate = localRuntime("restart");
  await expect(
    initializeLocalControl(repository, candidate.identity, 100),
  ).rejects.toThrow("local");
  await expect(
    initializeLocalControl(repository, runtime("ecs").identity, 100),
  ).rejects.toThrow("local");
  const client = new DynamoDBClient({
    region: "us-east-1",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  });
  const send = jest.spyOn(client, "send");
  const remote = createDynamoDeploymentControlRepository(client, {
    deploymentControl: "never",
    meetingHistory: "never",
  });
  await expect(
    initializeLocalControl(remote, candidate.identity, 100),
  ).rejects.toThrow("local");
  expect(send).not.toHaveBeenCalled();
  client.destroy();
});
test("lifecycle adopts local restart generation only from its authorized stored row", async () => {
  const old = { ...localRuntime("prior", "bot"), role: "serving" as const };
  old.readiness.expiresAt = 100;
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl(localControl([old]));
  await repository.writeRuntime(old);
  const identity = localRuntime("live", "bot").identity;
  const lifecycle = createRuntimeLifecycle({
    identity,
    runtimeMode: "bot",
    repository,
    protection: createRuntimeProtectionService({
      identity,
      now: () => 100,
      onUnsafe: jest.fn(),
    }),
    now: () => 100,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await initializeLocalControl(repository, identity, 100);
  await lifecycle.start();
  expect(lifecycle.isAcceptingWork()).toBe(false);
  await bootstrapLocalRuntime(
    repository,
    identity,
    () => lifecycle.refreshRuntimeReadiness(),
    () => 100,
  );
  expect(
    (await lifecycle.getRuntimeAdmissionContext()).authorizedGeneration,
  ).toBe(8);
  lifecycle.stop();
});

test("retired local owner is replaceable while a fresh unready owner is refused", async () => {
  const retired = {
    ...localRuntime("retired", "bot"),
    role: "retired" as const,
  };
  const first = await fixture([retired]);
  await expect(
    bootstrapLocalRuntime(
      first.repository,
      first.candidate.identity,
      async () => undefined,
      () => 100,
    ),
  ).resolves.toBeUndefined();
  const unready = {
    ...localRuntime("unready", "bot"),
    role: "serving" as const,
  };
  unready.readiness.dependenciesReady = false;
  const second = await fixture([unready]);
  await expect(
    bootstrapLocalRuntime(
      second.repository,
      second.candidate.identity,
      async () => undefined,
      () => 100,
    ),
  ).rejects.toThrow("Fresh local owner");
});
test("local CAS parity rejects refreshed snapshots and retries at most three times", async () => {
  const old = { ...localRuntime("expired", "bot"), role: "serving" as const };
  old.readiness.expiresAt = 100;
  const { repository, candidate } = await fixture([old]);
  const expected = localControl([old]);
  await repository.writeRuntime({
    ...old,
    readiness: { ...old.readiness, expiresAt: 130 },
  });
  expect(
    await repository.bootstrapLocal({
      control: expected,
      candidate,
      members: [old],
      now: 100,
    }),
  ).toBe("stale");
  const write = jest
    .spyOn(repository, "bootstrapLocal")
    .mockResolvedValue("stale");
  const refresh = jest.fn(async () => undefined);
  await expect(
    bootstrapLocalRuntime(repository, candidate.identity, refresh, () => 100),
  ).rejects.toThrow("three attempts");
  expect(write).toHaveBeenCalledTimes(3);
  expect(refresh).toHaveBeenCalledTimes(3);
});
test("remote endpoint cannot opt into local bootstrap and fresh candidate need not own an earlier generation", async () => {
  const client = new DynamoDBClient({
    endpoint: "https://dynamodb.us-east-1.amazonaws.com",
    region: "local",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
  });
  const send = jest.spyOn(client, "send");
  const remote = createDynamoDeploymentControlRepository(
    client,
    { deploymentControl: "never", meetingHistory: "never" },
    { localBootstrap: true },
  );
  expect(await remote.supportsLocalBootstrap()).toBe(false);
  await expect(remote.initializeControl(localControl())).rejects.toThrow(
    "local storage",
  );
  expect(send).not.toHaveBeenCalled();
  client.destroy();
  const { repository, candidate } = await fixture();
  const older = {
    ...candidate,
    identity: { ...candidate.identity, instanceId: "older" },
    sk: "RUNTIME#older",
    authorizedGeneration: 6,
  };
  older.readiness = { ...older.readiness, identity: older.identity };
  older.protection = { ...older.protection, identity: older.identity };
  expect(await repository.writeRuntime(older)).toBe("applied");
  expect(await repository.getRecord("ENV", "RUNTIME#older")).toEqual(older);
  expect(await repository.getRecord("ENV", "CONTROL")).toEqual(localControl());
  expect(
    await repository.bootstrapLocal({
      control: localControl(),
      candidate: older,
      members: [],
      now: 100,
    }),
  ).toBe("applied");
});
