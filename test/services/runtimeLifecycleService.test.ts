/** @jest-environment node */
import { RUNTIME_WORK_KINDS } from "../../src/types/deploymentControl";
import { createProcessShutdownOwner } from "../../src/services/processShutdownService";
import { createRuntimeLifecycle } from "../../src/services/runtimeLifecycleService";
import { createRuntimeProtectionService } from "../../src/services/runtimeProtectionService";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import type { RuntimeIdentity } from "../../src/types/deploymentControl";

const identity: RuntimeIdentity = {
  kind: "local",
  instanceId: "candidate",
  localId: "fixture",
  protocolVersion: 1,
};
const now = () => Math.floor(Date.now() / 1000);
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function repositoryFixture(
  runtimeEnvironment: "local" | "ecs" = "local",
) {
  const repository = createMockDeploymentControlRepository();
  await repository.initializeControl({
    pk: "ENV",
    sk: "CONTROL",
    recordType: "control",
    runtimeEnvironment,
    protocolVersion: 1,
    coordinatorToken: "coordinator",
    coordinatorEpoch: 1,
    coordinatorExpiresAt: 2000,
    servingGeneration: 0,
    servingMembers: {},
  });
  return repository;
}
async function fixture() {
  const repository = await repositoryFixture();
  const protection = createRuntimeProtectionService({
    identity,
    now,
    onUnsafe: jest.fn(),
  });
  const lifecycle = createRuntimeLifecycle({
    identity,
    repository,
    protection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await lifecycle.start();
  return { lifecycle, repository, protection };
}
async function promote(
  repository: ReturnType<typeof createMockDeploymentControlRepository>,
  candidate = identity,
  generation = 1,
) {
  const control = await repository.getRecord("ENV", "CONTROL");
  if (control?.recordType !== "control") throw new Error("missing control");
  expect(
    await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: generation - 1,
      expectedServingMembers: Object.values(control.servingMembers),
      candidate,
      proposedGeneration: generation,
      now: now(),
    }),
  ).toBe("applied");
}
async function replace(
  repository: ReturnType<typeof createMockDeploymentControlRepository>,
) {
  const row = await repository.getRecord("ENV", "RUNTIME#candidate");
  if (row?.recordType !== "runtime") throw new Error("missing fixture");
  const nextIdentity = { ...identity, instanceId: "replacement" };
  await repository.writeRuntime({
    ...row,
    sk: "RUNTIME#replacement",
    identity: nextIdentity,
    role: "candidate",
    readiness: { ...row.readiness, identity: nextIdentity },
    protection: { ...row.protection, identity: nextIdentity },
  });
  await promote(repository, nextIdentity, 2);
}
beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

test("warmRuntimeOwnsNoWork", async () => {
  const { lifecycle } = await fixture();
  expect(() => lifecycle.beginRuntimeWork("pending_admission")).toThrow();
  await expect(lifecycle.getRuntimeAdmissionContext()).rejects.toThrow();
  const warmClaims = Object.values(lifecycle.getWorkCounts()).filter(
    (count) => count > 0,
  );
  expect(warmClaims).toHaveLength(0);
  lifecycle.stop();
});

test("owned control stays counted after its draining parent settles", async () => {
  const { lifecycle, repository } = await fixture();
  await promote(repository);
  await lifecycle.getRuntimeAdmissionContext();
  const recording = lifecycle.beginRuntimeWork("recording");
  await replace(repository);
  await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 });
  const control = recording.beginOwnedControl();
  expect(Object.keys(control)).toEqual(["settle"]);
  recording.settle();
  expect(lifecycle.getWorkCounts().ancillary_delivery).toBe(1);
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("busy");
  expect(() => recording.beginOwnedControl()).toThrow();
  control.settle();
  control.settle();
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("retired");
  lifecycle.stop();
});

test("pending admission cannot grant existing owner control authority", async () => {
  const { lifecycle, repository } = await fixture();
  await promote(repository);
  await lifecycle.getRuntimeAdmissionContext();
  const pending = lifecycle.beginRuntimeWork("pending_admission");
  expect(() => pending.beginOwnedControl()).toThrow();
  pending.settle();
  lifecycle.stop();
});

test("an unsafe session parent cannot grant a control child", async () => {
  const { lifecycle, repository, protection } = await fixture();
  await promote(repository);
  await lifecycle.getRuntimeAdmissionContext();
  const recording = lifecycle.beginRuntimeWork("recording");
  await protection.release();
  expect(() => recording.beginOwnedControl()).toThrow(
    "Session cannot grant control ownership",
  );
  expect(lifecycle.getWorkCounts().ancillary_delivery).toBe(0);
  recording.settle();
  lifecycle.stop();
});

test("readinessRequiresGatewayAndRequiredDependencies", async () => {
  const { lifecycle, repository } = await fixture();
  lifecycle.registerSafetyHandler(undefined);
  await lifecycle.refreshRuntimeReadiness();
  expect(
    await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 0,
      expectedServingMembers: [],
      candidate: identity,
      proposedGeneration: 1,
      now: now(),
    }),
  ).toBe("stale");
  lifecycle.stop();
});

test("retirementCannotUnprotectOtherOwnedWork", async () => {
  const { lifecycle, repository, protection } = await fixture();
  await promote(repository);
  await lifecycle.getRuntimeAdmissionContext();
  const recording = lifecycle.beginRuntimeWork("recording");
  const upload = lifecycle.beginRuntimeWork("personal_processing");
  recording.settle();
  recording.settle();
  await replace(repository);
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("busy");
  expect(protection.getConfirmation()).toBeDefined();
  upload.settle();
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("retired");
  expect(protection.getConfirmation()).toBeUndefined();
  lifecycle.stop();
});

test("reauthorizationWaitsForPendingProtectionRelease", async () => {
  const repository = await repositoryFixture("ecs");
  const ecs: RuntimeIdentity = {
    kind: "ecs",
    instanceId: "ecs",
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/abc",
    imageDigest: `sha256:${"a".repeat(64)}`,
    candidateId: "release",
    protocolVersion: 1,
  };
  const releaseStarted = barrier<void>();
  const release = barrier<Response>();
  let unprotectCalls = 0;
  const request: typeof fetch = jest.fn(async (_url, init) => {
    if (init?.body === JSON.stringify({ ProtectionEnabled: false })) {
      unprotectCalls++;
      releaseStarted.resolve();
      return release.promise;
    }
    return Response.json({
      protection: {
        TaskArn: ecs.taskArn,
        ProtectionEnabled: true,
        ExpirationDate: new Date(Date.now() + 600_000).toISOString(),
      },
    });
  });
  const protection = createRuntimeProtectionService({
    identity: ecs,
    agentUri: "http://agent",
    request,
    now,
    onUnsafe: jest.fn(),
  });
  const lifecycle = createRuntimeLifecycle({
    identity: ecs,
    repository,
    protection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await lifecycle.start();
  await promote(repository, ecs);
  await lifecycle.getRuntimeAdmissionContext();
  const work = lifecycle.beginRuntimeWork("personal_processing");
  // Publish a fresh candidate for the next generation before retiring ECS.
  const old = await repository.getRecord("ENV", "RUNTIME#ecs");
  if (old?.recordType !== "runtime") throw new Error("missing fixture");
  const replacement = { ...ecs, instanceId: "replacement" };
  await repository.writeRuntime({
    ...old,
    sk: "RUNTIME#replacement",
    identity: replacement,
    role: "candidate",
    readiness: {
      ...old.readiness,
      identity: replacement,
      observedGeneration: 1,
    },
    protection: { ...old.protection, identity: replacement },
  });
  await promote(repository, replacement, 2);
  await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 });
  const unprotectCallsWhileOwnedWorkRemains = unprotectCalls;
  expect(unprotectCallsWhileOwnedWorkRemains).toBe(0);
  work.settle();
  const retirement = lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 });
  await releaseStarted.promise;
  expect(await repository.getRecord("ENV", "RUNTIME#ecs")).toMatchObject({
    role: "releasing",
    readiness: { dependenciesReady: false },
  });
  let rearmed = false;
  const reauthorization = lifecycle
    .reauthorizeRuntime({ retirementEpoch: 1 })
    .then(() => {
      rearmed = true;
    });
  const promotedWhileReleasePending =
    (await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 2,
      expectedServingMembers: [replacement],
      candidate: ecs,
      proposedGeneration: 3,
      now: now(),
    })) === "applied";
  expect(promotedWhileReleasePending).toBe(false);
  expect(rearmed).toBe(false);
  release.resolve(
    Response.json({
      protection: {
        TaskArn: ecs.taskArn,
        ProtectionEnabled: false,
        ExpirationDate: null,
      },
    }),
  );
  expect((await retirement).kind).toBe("retired");
  await reauthorization;
  await promote(repository, ecs, 3);
  expect(
    (await lifecycle.getRuntimeAdmissionContext()).authorizedGeneration,
  ).toBe(3);
  expect(protection.isSafe()).toBe(true);
  lifecycle.stop();
});

test.each(["gatewayReady", "cacheReady", "dependenciesReady"] as const)(
  "missing %s prevents promotion",
  async (missing) => {
    const { lifecycle: unused, repository } = await fixture();
    unused.stop();
    const candidate = { ...identity, instanceId: "not-ready" };
    const protection = createRuntimeProtectionService({
      identity: candidate,
      now,
      onUnsafe: jest.fn(),
    });
    const lifecycle = createRuntimeLifecycle({
      identity: candidate,
      repository,
      protection,
      now,
      probeReadiness: async () => ({
        gatewayReady: true,
        cacheReady: true,
        dependenciesReady: true,
        [missing]: false,
      }),
      checkpointAndFence: jest.fn(),
    });
    await lifecycle.start();
    expect(
      await repository.promote({
        candidateRuntimeMode: "all",
        coordinatorToken: "coordinator",
        coordinatorEpoch: 1,
        expectedServingGeneration: 0,
        expectedServingMembers: [],
        candidate,
        proposedGeneration: 1,
        now: now(),
      }),
    ).toBe("stale");
    lifecycle.stop();
  },
);

test("staleReadinessPreventsPromotion", async () => {
  const { lifecycle, repository } = await fixture();
  lifecycle.stop();
  jest.setSystemTime(1_031_000);
  expect(
    await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 0,
      expectedServingMembers: [],
      candidate: identity,
      proposedGeneration: 1,
      now: now(),
    }),
  ).toBe("stale");
});

test("retained API runtime adopts only its explicitly authorized generation", async () => {
  const { lifecycle: bot, repository } = await fixture();
  await promote(repository);
  await bot.getRuntimeAdmissionContext();
  const recording = bot.beginRuntimeWork("recording");
  const apiIdentity = { ...identity, instanceId: "api" };
  const apiProtection = createRuntimeProtectionService({
    identity: apiIdentity,
    now,
    onUnsafe: jest.fn(),
  });
  const api = createRuntimeLifecycle({
    identity: apiIdentity,
    runtimeMode: "api",
    repository,
    protection: apiProtection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await api.start();
  expect(
    await repository.promote({
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 1,
      expectedServingMembers: [identity],
      candidate: apiIdentity,
      candidateRuntimeMode: "api",
      retainedMembers: [identity],
      proposedGeneration: 2,
      now: now(),
    }),
  ).toBe("applied");
  expect((await api.getRuntimeAdmissionContext()).authorizedGeneration).toBe(2);
  const upload = api.beginRuntimeWork("personal_processing");
  const nextIdentity = { ...identity, instanceId: "replacement" };
  const nextProtection = createRuntimeProtectionService({
    identity: nextIdentity,
    now,
    onUnsafe: jest.fn(),
  });
  const next = createRuntimeLifecycle({
    identity: nextIdentity,
    repository,
    protection: nextProtection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await next.start();
  expect(
    await repository.promote({
      candidateRuntimeMode: "all",
      coordinatorToken: "coordinator",
      coordinatorEpoch: 1,
      expectedServingGeneration: 2,
      expectedServingMembers: [identity, apiIdentity],
      candidate: nextIdentity,
      retainedMembers: [apiIdentity],
      proposedGeneration: 3,
      now: now(),
    }),
  ).toBe("applied");
  expect((await api.getRuntimeAdmissionContext()).authorizedGeneration).toBe(3);
  await expect(bot.getRuntimeAdmissionContext()).rejects.toThrow();
  expect(() => bot.beginRuntimeWork("pending_admission")).toThrow();
  recording.transition("finalization");
  expect(
    (await bot.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("busy");
  expect(api.getWorkCounts().personal_processing).toBe(1);
  recording.settle();
  upload.settle();
  bot.stop();
  api.stop();
  next.stop();
});

test("protection loss closes admission and fences owned API work before expiry", async () => {
  const repository = await repositoryFixture("ecs");
  const ecs: RuntimeIdentity = {
    kind: "ecs",
    instanceId: "bounded",
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/bounded",
    imageDigest: `sha256:${"a".repeat(64)}`,
    candidateId: "release",
    protocolVersion: 1,
  };
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        protection: {
          TaskArn: ecs.taskArn,
          ProtectionEnabled: true,
          ExpirationDate: "1970-01-01T00:26:40Z",
        },
      }),
    )
    .mockRejectedValue(new Error("offline"));
  const protection = createRuntimeProtectionService({
    identity: ecs,
    agentUri: "http://agent",
    request,
    now,
    onUnsafe: jest.fn(),
  });
  const checkpointAndFence = jest.fn(async () => undefined);
  const lifecycle = createRuntimeLifecycle({
    identity: ecs,
    repository,
    protection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence,
  });
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  await lifecycle.start();
  await promote(repository, ecs);
  await lifecycle.getRuntimeAdmissionContext();
  const work = lifecycle.beginRuntimeWork("personal_processing");
  await jest.advanceTimersByTimeAsync(480_000);
  expect(checkpointAndFence).toHaveBeenCalledTimes(1);
  expect(() => lifecycle.beginRuntimeWork("pending_admission")).toThrow();
  expect(lifecycle.getReadiness()?.expiresAt).toBeLessThanOrEqual(1480);
  work.settle();
  lifecycle.stop();
  warn.mockRestore();
});

test("uncertain release cannot reauthorize", async () => {
  const repository = await repositoryFixture("ecs");
  const ecs: RuntimeIdentity = {
    kind: "ecs",
    instanceId: "uncertain",
    taskArn: "arn:aws:ecs:us-east-1:123456789012:task/test/uncertain",
    imageDigest: `sha256:${"a".repeat(64)}`,
    candidateId: "release",
    protocolVersion: 1,
  };
  const request = jest
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        protection: {
          TaskArn: ecs.taskArn,
          ProtectionEnabled: true,
          ExpirationDate: "1970-01-01T00:26:40Z",
        },
      }),
    )
    .mockRejectedValue(new Error("release timed out"));
  const protection = createRuntimeProtectionService({
    identity: ecs,
    agentUri: "http://agent",
    request,
    now,
    onUnsafe: jest.fn(),
  });
  const lifecycle = createRuntimeLifecycle({
    identity: ecs,
    repository,
    protection,
    now,
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
    checkpointAndFence: jest.fn(),
  });
  await lifecycle.start();
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("uncertain");
  expect(await repository.getRecord("ENV", "RUNTIME#uncertain")).toMatchObject({
    role: "releasing",
    readiness: { dependenciesReady: false },
  });
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("uncertain");
  await expect(
    lifecycle.reauthorizeRuntime({ retirementEpoch: 1 }),
  ).rejects.toThrow("not been confirmed");
  expect(request).toHaveBeenCalledTimes(2);
  lifecycle.stop();
});

test("shutdown closes admission immediately and observes an actual pending runtime heartbeat", async () => {
  const { lifecycle, repository } = await fixture();
  const pending = barrier<void>();
  const entered = barrier<void>();
  const original = repository.getRecord.bind(repository);
  jest
    .spyOn(repository, "getRecord")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await pending.promise;
      return original(...args);
    });
  const heartbeat = lifecycle.refreshRuntimeReadiness().catch(() => undefined);
  await entered.promise;
  let settled = false;
  const stopping = lifecycle.shutdown().then(() => {
    settled = true;
  });
  expect(lifecycle.isAcceptingWork()).toBe(false);
  await Promise.resolve();
  expect(settled).toBe(false);
  pending.resolve();
  await heartbeat;
  await stopping;
  expect(lifecycle.isAcceptingWork()).toBe(false);
});

test("all seven real work handles share one deadline and pending recovery cannot certify retirement", async () => {
  const { lifecycle, repository } = await fixture();
  await promote(repository);
  await lifecycle.getRuntimeAdmissionContext();
  const held = RUNTIME_WORK_KINDS.map((kind) => {
    const handle = lifecycle.beginRuntimeWork(kind);
    const tail = barrier<void>();
    return { kind, tail, actual: tail.promise.then(() => handle.settle()) };
  });
  await replace(repository);
  expect(
    (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
  ).toBe("busy");
  expect(Object.values(lifecycle.getWorkCounts())).toEqual(
    RUNTIME_WORK_KINDS.map(() => 1),
  );
  const exit = jest.fn();
  const owner = createProcessShutdownOwner({
    closeAdmission: () => lifecycle.closeAdmission(),
    async preserve(budget) {
      await Promise.all([
        lifecycle.shutdown(),
        ...held.map((entry) => entry.actual),
      ]);
      budget.signal.throwIfAborted();
      return Object.values(lifecycle.getWorkCounts()).every(
        (count) => count === 0,
      );
    },
    flush: async () => {},
    exit,
  });
  try {
    const first = owner.request("protection_loss");
    const deadline = owner.checkpoint().deadline;
    for (const entry of held)
      if (entry.kind !== "recovery_processing") entry.tail.resolve();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
    expect(
      (await lifecycle.prepareRuntimeRetirement({ retirementEpoch: 1 })).kind,
    ).toBe("busy");
    expect(owner.request("signal")).toBe(first);
    expect(owner.checkpoint().deadline).toBe(deadline);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await first).toEqual({ kind: "unresolved" });
    expect(owner.checkpoint().actualSettled).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lifecycle.getWorkCounts().recovery_processing).toBe(1);
    expect(
      Object.values(lifecycle.getWorkCounts()).reduce((a, b) => a + b, 0),
    ).toBe(1);
  } finally {
    for (const entry of held) entry.tail.resolve();
    await owner.checkpoint().actual;
    owner.dispose();
    lifecycle.stop();
  }
});

test("actual runtime start and refreshed heartbeat advertise exact canonical writer capability", async () => {
  const { lifecycle, repository } = await fixture();
  try {
    expect(
      await repository.getRecord("ENV", "RUNTIME#" + identity.instanceId),
    ).toMatchObject({
      identity,
      canonicalContentWriter: 1,
    });
    await lifecycle.refreshRuntimeReadiness();
    expect(
      await repository.getRecord("ENV", "RUNTIME#" + identity.instanceId),
    ).toMatchObject({
      identity,
      canonicalContentWriter: 1,
    });
  } finally {
    lifecycle.stop();
  }
});
