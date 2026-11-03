/** @jest-environment node */
import { createRuntimeArtifactSafety } from "../../src/services/runtimeArtifactSafety";
import { createArtifactAdmissionGate } from "../../src/services/artifactAdmissionGate";
import { createMockArtifactSafetyRepository } from "../../src/repositories/artifactSafetyRepository";
import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
import { artifactSafetyFixture } from "../deployment/fixtures/artifactSafetyFixture";
import {
  artifactSafetyBaseSchema,
  artifactSafetyRecordSchema,
} from "../../src/types/artifactSafety";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";

beforeEach(() => jest.useFakeTimers({ now: 120_000 }));
afterEach(() => jest.useRealTimers());

function fixture() {
  const f = artifactSafetyFixture();
  const initial = artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    state: "idle",
  });
  const records = new Map<string, DeploymentControlRecord>([
    [JSON.stringify(["ENV", "CONTROL"]), structuredClone(f.ctl)],
    [JSON.stringify(["ENV", "RUNTIME#old"]), structuredClone(f.source)],
  ]);
  const artifacts = new Map([[initial.sk, initial]]);
  const repository = createMockArtifactSafetyRepository({
    records,
    artifacts,
    histories: new Map(),
  });
  const control = createMockDeploymentControlRepository(records);
  const admission = createArtifactAdmissionGate();
  const snapshot = f.expected.proof.snapshot;
  const storage = {
    seal: jest.fn(async () => snapshot),
    recheck: jest.fn(async () => snapshot),
    resume: jest.fn(),
  };
  const clock = { now: 120 };
  const safety = createRuntimeArtifactSafety({
    identity: f.source.identity,
    repository,
    control,
    admission,
    storage,
    now: () => clock.now,
    isProtected: () => true,
  });
  async function request() {
    const current = await repository.read(f.source.identity);
    if (!current) throw new Error("Missing fixture capability");
    const next = artifactSafetyRecordSchema.parse({
      ...artifactSafetyBaseSchema.parse(current),
      revision: current.revision + 1,
      state: "requested",
      request: {
        ...f.expected.request,
        requestedAt: clock.now,
        expiresAt: clock.now + 30,
      },
    });
    expect(
      await repository.write({
        purpose: "request",
        expected: current,
        next,
        context: { kind: "preparing", control: f.ctl, runtime: f.source },
        now: clock.now,
      }),
    ).toBe("applied");
  }
  return {
    ...f,
    repository,
    records,
    artifacts,
    control,
    admission,
    storage,
    clock,
    safety,
    request,
  };
}
async function until(predicate: () => Promise<boolean>) {
  for (let index = 0; index < 100; index++) {
    if (await predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Expected protocol state was not reached");
}

test("the worker fences immediately and proves storage only after accepted producers and owned stops settle", async () => {
  const f = fixture();
  const producer = f.admission.begin();
  await f.request();
  try {
    await f.safety.refresh();
    expect(() => f.admission.begin()).toThrow("sealed");
    const stop = producer.beginOwned();
    producer.settle();
    expect(f.storage.seal).not.toHaveBeenCalled();
    stop.settle();
    await until(
      async () =>
        (await f.repository.read(f.source.identity))?.state === "sealed",
    );
    expect(f.storage.seal).toHaveBeenCalledTimes(1);
    expect(f.admission.sealed).toBe(true);
  } finally {
    f.safety.stop();
  }
});

test("only a guarded cancellation resumes admission, while existing ownership remains counted", async () => {
  const f = fixture();
  const producer = f.admission.begin();
  await f.request();
  try {
    await f.safety.refresh();
    await until(
      async () =>
        (await f.repository.read(f.source.identity))?.state === "draining",
    );
    const current = await f.repository.read(f.source.identity);
    if (!current || !("request" in current)) throw new Error("Missing request");
    const next = artifactSafetyRecordSchema.parse({
      ...artifactSafetyBaseSchema.parse(current),
      revision: current.revision + 1,
      state: "cancel_requested",
      request: current.request,
    });
    expect(
      await f.repository.write({
        purpose: "cancel",
        expected: current,
        next,
        context: { kind: "preparing", control: f.ctl, runtime: f.source },
        now: f.clock.now,
      }),
    ).toBe("applied");
    await f.safety.refresh();
    expect((await f.repository.read(f.source.identity))?.state).toBe(
      "cancelled",
    );
    expect(await f.control.getRecord("ENV", "CONTROL")).toMatchObject({
      servingGeneration: f.ctl.servingGeneration,
      servingMembers: f.ctl.servingMembers,
      deployment: { phase: "complete", runToken: f.ctl.coordinatorToken },
    });
    expect(f.storage.resume).toHaveBeenCalledTimes(1);
    expect(f.admission.active).toBe(1);
    const newWork = f.admission.begin();
    newWork.settle();
    producer.settle();
    expect(f.storage.seal).not.toHaveBeenCalled();
  } finally {
    f.safety.stop();
  }
});

test("expiry refuses preservation without reopening producer admission", async () => {
  const f = fixture();
  await f.request();
  f.clock.now = 151;
  try {
    await f.safety.refresh();
    await until(
      async () =>
        (await f.repository.read(f.source.identity))?.state === "blocked",
    );
    expect(() => f.admission.begin()).toThrow("sealed");
    expect(f.storage.resume).not.toHaveBeenCalled();
    expect(f.storage.seal).not.toHaveBeenCalled();
  } finally {
    f.safety.stop();
  }
});

test("candidate startup stays fenced until native serving ownership permits activation", async () => {
  const f = fixture();
  f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), {
    ...f.source,
    role: "candidate",
  });
  const initial = await f.repository.read(f.source.identity);
  if (!initial) throw new Error("Missing capability");
  f.artifacts.set(
    initial.sk,
    artifactSafetyRecordSchema.parse({
      ...artifactSafetyBaseSchema.parse(initial),
      state: "idle",
      startup: { kind: "pending" },
    }),
  );
  try {
    await f.safety.startupReady();
    expect(f.admission.sealed).toBe(true);
    expect(f.storage.resume).not.toHaveBeenCalled();
    f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), f.source);
    await f.safety.refresh();
    expect((await f.repository.read(f.source.identity))?.startup.kind).toBe(
      "active",
    );
    expect(f.admission.sealed).toBe(false);
  } finally {
    f.safety.stop();
  }
});

test("retired-runtime reactivation cannot protect a candidate without source preservation", async () => {
  const f = fixture();
  await expect(f.safety.authorizeReactivation()).rejects.toThrow(
    "fresh protected handoff",
  );
  expect(f.storage.resume).not.toHaveBeenCalled();
  f.safety.stop();
});

async function readyLocalResume(
  f: ReturnType<typeof fixture>,
  purpose: "activate" | "cancel_ack",
) {
  if (purpose === "activate") {
    f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), {
      ...f.source,
      role: "candidate",
    });
    await f.safety.startupReady();
    f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), f.source);
  } else {
    await f.request();
    await f.safety.refresh();
    await until(
      async () =>
        (await f.repository.read(f.source.identity))?.state === "sealed",
    );
    const current = await f.repository.read(f.source.identity);
    if (current?.state !== "sealed")
      throw new Error("Missing sealed cancellation fixture");
    await f.repository.write({
      purpose: "cancel",
      expected: current,
      next: artifactSafetyRecordSchema.parse({
        ...artifactSafetyBaseSchema.parse(current),
        revision: current.revision + 1,
        state: "cancel_requested",
        request: current.request,
      }),
      context: { kind: "preparing", control: f.ctl, runtime: f.source },
      now: f.clock.now,
    });
  }
}
test.each(["activate", "cancel_ack"] as const)(
  "lost %s response reconciles its exact durable acknowledgment before local resume",
  async (purpose) => {
    const f = fixture();
    await readyLocalResume(f, purpose);
    const write = f.repository.write.bind(f.repository);
    let lost = false;
    const failure = jest
      .spyOn(f.repository, "write")
      .mockImplementation(async (input, signal) => {
        const result = await write(input, signal);
        if (input.purpose === purpose && !lost) {
          lost = true;
          throw new Error(
            "Committed, response and immediate readback unavailable",
          );
        }
        return result;
      });
    try {
      await f.safety.refresh();
      expect(lost).toBe(true);
      expect(f.admission.sealed).toBe(true);
      await f.safety.refresh();
      await f.safety.refresh();
      expect(f.admission.sealed).toBe(false);
      expect(f.storage.resume).toHaveBeenCalledTimes(1);
    } finally {
      failure.mockRestore();
      f.safety.stop();
    }
  },
);
test("a lost activation acknowledgment cannot reopen after serving ownership changes", async () => {
  const f = fixture();
  await readyLocalResume(f, "activate");
  const write = f.repository.write.bind(f.repository);
  const failure = jest
    .spyOn(f.repository, "write")
    .mockImplementation(async (input, signal) => {
      const result = await write(input, signal);
      if (input.purpose === "activate")
        throw new Error("Committed but unacknowledged");
      return result;
    });
  try {
    await f.safety.refresh();
    f.records.set(JSON.stringify(["ENV", "CONTROL"]), {
      ...f.ctl,
      servingMembers: {},
    });
    await f.safety.refresh();
    expect(f.admission.sealed).toBe(true);
    expect(f.storage.resume).not.toHaveBeenCalled();
  } finally {
    failure.mockRestore();
    f.safety.stop();
  }
});

test("a guarded rollback rechecks the preserved inventory before reopening the original source", async () => {
  const f = fixture();
  await f.request();
  await f.safety.refresh();
  await until(
    async () =>
      (await f.repository.read(f.source.identity))?.state === "sealed",
  );
  const expected = await f.repository.read(f.source.identity);
  if (expected?.state !== "sealed")
    throw new Error("Missing preservation proof");
  expect(
    await f.repository.write({
      purpose: "consume",
      expected,
      next: {
        ...expected,
        revision: expected.revision + 1,
        state: "consumed",
        consumedAt: 120,
      },
      context: { kind: "preparing", control: f.ctl, runtime: f.source },
      now: 120,
    }),
  ).toBe("applied");
  f.clock.now = 160;
  f.records.set(JSON.stringify(["ENV", "CONTROL"]), {
    ...f.ctl,
    servingGeneration: f.ctl.servingGeneration + 2,
    deployment: { ...f.ctl.deployment!, phase: "rolled_back" },
  });
  f.records.set(JSON.stringify(["ENV", "RUNTIME#old"]), {
    ...f.source,
    authorizedGeneration: f.ctl.servingGeneration + 2,
  });
  try {
    await f.safety.refresh();
    await f.safety.refresh();
    expect(f.storage.recheck).toHaveBeenCalledWith(
      expected.proof.snapshot,
      undefined,
    );
    expect(f.admission.sealed).toBe(false);
    expect((await f.repository.read(f.source.identity))?.startup.kind).toBe(
      "active",
    );
  } finally {
    f.safety.stop();
  }
});
