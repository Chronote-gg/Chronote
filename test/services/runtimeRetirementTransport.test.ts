/** @jest-environment node */
import { createRuntimeLifecycle } from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import type {
  DeploymentControlRecord,
  RuntimeIdentity,
  RuntimeRecord,
} from "../../src/types/deploymentControl";

const identity: RuntimeIdentity = {
  kind: "ecs",
  instanceId: "old",
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/old",
  imageDigest: "sha256:old",
  candidateId: "old",
  protocolVersion: 1,
};
async function fixture() {
  const records = new Map<string, DeploymentControlRecord>();
  const repository = createMockDeploymentControlRepository(records);
  const control = {
    pk: "ENV" as const,
    sk: "CONTROL" as const,
    recordType: "control" as const,
    runtimeEnvironment: "ecs" as const,
    protocolVersion: 1 as const,
    coordinatorToken: "run",
    coordinatorEpoch: 2,
    coordinatorExpiresAt: 2000,
    servingGeneration: 1,
    servingMembers: {},
  };
  await repository.initializeControl(control);
  const native = jest.fn(async (_url, init) => ({
    ok: true,
    json: async () => ({
      protection: {
        TaskArn: identity.taskArn,
        ProtectionEnabled: JSON.parse(init.body).ProtectionEnabled,
        ExpirationDate: new Date(1600000).toISOString(),
      },
    }),
  }));
  const protection = createRuntimeProtectionService({
    identity,
    agentUri: "http://fixture",
    request: native as unknown as typeof fetch,
    now: () => 1000,
    onUnsafe: jest.fn(),
  });
  const runtime = createRuntimeLifecycle({
    identity,
    repository,
    protection,
    now: () => 1000,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await runtime.start();
  const row = (await repository.getRecord(
    "ENV",
    "RUNTIME#old",
  )) as RuntimeRecord;
  const request = {
    identity,
    authorizedGeneration: 1,
    coordinatorToken: "run",
    coordinatorEpoch: 2,
  };
  return { records, repository, runtime, native, control, row, request };
}
afterEach(() => jest.useRealTimers());
beforeEach(() => jest.useFakeTimers());

test("heartbeatConsumesExactRetirementRequestAndAcknowledgesNativeRelease", async () => {
  const f = await fixture();
  expect(
    await f.repository.requestRetirement({
      record: f.row,
      request: f.request,
      now: 1000,
    }),
  ).toBe("applied");
  await f.runtime.refreshRuntimeReadiness();
  const row = (await f.repository.getRecord(
    "ENV",
    "RUNTIME#old",
  )) as RuntimeRecord;
  expect(row.role).toBe("retired");
  expect(row.retirementAcknowledgment?.request).toEqual(f.request);
  expect(
    f.native.mock.calls.filter(
      ([, init]) => !JSON.parse(init.body).ProtectionEnabled,
    ),
  ).toHaveLength(1);
  await f.runtime.refreshRuntimeReadiness();
  expect(f.native).toHaveBeenCalledTimes(2);
  f.runtime.stop();
});

test("heldHeartbeatCannotEraseRetirementRequest", async () => {
  const f = await fixture();
  expect(
    await f.repository.requestRetirement({
      record: f.row,
      request: f.request,
      now: 1000,
    }),
  ).toBe("applied");
  expect(await f.repository.writeRuntime({ ...f.row, heartbeatAt: 1001 })).toBe(
    "stale",
  );
  expect(
    ((await f.repository.getRecord("ENV", "RUNTIME#old")) as RuntimeRecord)
      .retirementRequest,
  ).toEqual(f.request);
  f.runtime.stop();
});

test("staleEpochRequestNeverClosesOrUnprotectsRuntime", async () => {
  const f = await fixture();
  expect(
    await f.repository.requestRetirement({
      record: f.row,
      request: { ...f.request, coordinatorEpoch: 1 },
      now: 1000,
    }),
  ).toBe("stale");
  await f.runtime.refreshRuntimeReadiness();
  expect(f.native).toHaveBeenCalledTimes(1);
  expect(f.runtime.getRole()).toBe("candidate");
  f.runtime.stop();
});

test("ambiguousNativeReleaseNeverAcknowledgesRetirement", async () => {
  const f = await fixture();
  await f.repository.requestRetirement({
    record: f.row,
    request: f.request,
    now: 1000,
  });
  f.native.mockRejectedValueOnce(new Error("response lost"));
  await f.runtime.refreshRuntimeReadiness();
  const row = (await f.repository.getRecord(
    "ENV",
    "RUNTIME#old",
  )) as RuntimeRecord;
  expect(row.role).toBe("releasing");
  expect(row.retirementAcknowledgment).toBeUndefined();
  await f.runtime.refreshRuntimeReadiness();
  expect(f.native).toHaveBeenCalledTimes(2);
  f.runtime.stop();
});

test("heldActualHeartbeatCannotOverwriteConcurrentRequest", async () => {
  const f = await fixture();
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const write = f.repository.writeRuntime;
  jest
    .spyOn(f.repository, "writeRuntime")
    .mockImplementationOnce(async (row) => {
      entered();
      await gate;
      return write(row);
    });
  const heartbeat = f.runtime.refreshRuntimeReadiness();
  await waiting;
  expect(
    await f.repository.requestRetirement({
      record: f.row,
      request: f.request,
      now: 1000,
    }),
  ).toBe("applied");
  release();
  await expect(heartbeat).rejects.toThrow("changed during heartbeat");
  await f.runtime.refreshRuntimeReadiness();
  expect(
    ((await f.repository.getRecord("ENV", "RUNTIME#old")) as RuntimeRecord)
      .retirementAcknowledgment?.request,
  ).toEqual(f.request);
  f.runtime.stop();
});

test("staleRequestOnCurrentServingMemberNeverClosesAdmission", async () => {
  const f = await fixture();
  f.records.set(
    JSON.stringify(["ENV", "CONTROL"]),
    structuredClone({ ...f.control, servingMembers: { old: identity } }),
  );
  f.records.set(
    JSON.stringify(["ENV", "RUNTIME#old"]),
    structuredClone({
      ...f.row,
      role: "serving",
      retirementRequest: { ...f.request, coordinatorEpoch: 1 },
    }),
  );
  await f.runtime.refreshRuntimeReadiness();
  expect(f.runtime.isAcceptingWork()).toBe(true);
  expect(f.native).toHaveBeenCalledTimes(1);
  f.runtime.stop();
});

test("rearmedRuntimeDoesNotReplayOldGenerationRequest", async () => {
  const f = await fixture();
  await f.repository.requestRetirement({
    record: f.row,
    request: f.request,
    now: 1000,
  });
  await f.runtime.refreshRuntimeReadiness();
  await f.runtime.reauthorizeRuntime({ retirementEpoch: 2 });
  const current = (await f.repository.getRecord(
    "ENV",
    "RUNTIME#old",
  )) as RuntimeRecord;
  expect(current.retirementAcknowledgment).toBeUndefined();
  expect(current.retirementRequest).toBeUndefined();
  f.records.set(
    JSON.stringify(["ENV", "RUNTIME#old"]),
    structuredClone({
      ...current,
      retirementRequest: { ...f.request, authorizedGeneration: 0 },
    }),
  );
  await f.runtime.refreshRuntimeReadiness();
  expect(f.runtime.getRole()).toBe("candidate");
  expect(f.native).toHaveBeenCalledTimes(3);
  f.runtime.stop();
});

test("authorityIsRecheckedImmediatelyBeforeNativeRelease", async () => {
  const f = await fixture();
  await f.repository.requestRetirement({
    record: f.row,
    request: f.request,
    now: 1000,
  });
  const transition = f.repository.transitionRuntimeRole;
  jest
    .spyOn(f.repository, "transitionRuntimeRole")
    .mockImplementation(async (input) => {
      const result = await transition(input);
      if (input.record.role === "releasing")
        f.records.set(JSON.stringify(["ENV", "CONTROL"]), {
          ...f.control,
          coordinatorEpoch: 3,
        });
      return result;
    });
  await f.runtime.refreshRuntimeReadiness();
  expect(f.native).toHaveBeenCalledTimes(1);
  expect(
    ((await f.repository.getRecord("ENV", "RUNTIME#old")) as RuntimeRecord)
      .retirementAcknowledgment,
  ).toBeUndefined();
  f.runtime.stop();
});
