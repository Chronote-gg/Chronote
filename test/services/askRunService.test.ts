/** @jest-environment node */
import { createMemoryAskRunRepository } from "../../src/repositories/askRunRepository";
import { createAskRunService } from "../../src/services/askRunService";

const input = {
  userId: "user",
  guildId: "guild",
  conversationId: "conversation",
  requestId: "request",
  question: "Question?",
};
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe("durable Ask runs", () => {
  it("returns one accepted run on duplicate and uncertain sends", async () => {
    const repository = createMemoryAskRunRepository();
    const execute = jest.fn(() => new Promise<never>(() => {}));
    const a = createAskRunService({ repository, execute });
    const b = createAskRunService({ repository, execute });
    const [first, duplicate] = await Promise.all([
      a.start(input),
      b.start(input),
    ]);
    expect(first.runId).toBe(duplicate.runId);
    await flush();
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(b.start({ ...input, requestId: "another" })).rejects.toThrow(
      "active",
    );
    await b.stop({ ...input, runId: first.runId });
    a.dispose();
    b.dispose();
  });

  it("stops another replica and fences late text and completion", async () => {
    const repository = createMemoryAskRunRepository();
    let finish!: (value: {
      result: { answer: string };
      privateState: unknown;
    }) => void;
    let signal!: AbortSignal;
    let delta!: (text: string) => void;
    const a = createAskRunService({
      repository,
      pollMs: 5,
      execute: async (context) => {
        signal = context.signal;
        delta = context.onTextDelta;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const b = createAskRunService({ repository, execute: jest.fn() });
    const accepted = await a.start(input);
    await flush();
    await b.stop({ ...input, runId: accepted.runId });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signal.aborted).toBe(true);
    delta("late");
    finish({
      result: { answer: "late" },
      privateState: { secret: "tool body" },
    });
    await flush();
    expect(await b.get({ ...input, runId: accepted.runId })).toMatchObject({
      status: "stopped",
      text: "",
    });
    a.dispose();
    b.dispose();
  });

  it("interrupts an expired owner without replay and isolates principal scope", async () => {
    let now = 1000;
    const repository = createMemoryAskRunRepository();
    const execute = jest.fn(() => new Promise<never>(() => {}));
    const a = createAskRunService({
      repository,
      execute,
      now: () => now,
      leaseMs: 100,
      pollMs: 10000,
    });
    const accepted = await a.start(input);
    await flush();
    now = 1200;
    expect(await a.get({ ...input, runId: accepted.runId })).toMatchObject({
      status: "interrupted",
    });
    expect((await a.start(input)).runId).toBe(accepted.runId);
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      a.get({ ...input, userId: "other", runId: accepted.runId }),
    ).rejects.toThrow("not found");
    a.dispose();
  });

  it("stores private history without exposing it in snapshots", async () => {
    const repository = createMemoryAskRunRepository();
    const service = createAskRunService({
      repository,
      execute: async () => ({
        result: { answer: "Answer" },
        privateState: {
          history: ["private tool body"],
          provenance: ["source"],
        },
      }),
    });
    const accepted = await service.start(input);
    await flush();
    const saved = await service.get({ ...input, runId: accepted.runId });
    expect(saved.status).toBe("completed");
    expect(JSON.stringify(saved)).not.toContain("private tool body");
    expect(await repository.getPrivateState(input)).toEqual({
      history: ["private tool body"],
      provenance: ["source"],
    });
    service.dispose();
  });
});

it("reconciles a lost acceptance acknowledgement without replay", async () => {
  const memory = createMemoryAskRunRepository();
  const repository = {
    ...memory,
    create: async (record: Parameters<typeof memory.create>[0]) => {
      await memory.create(record);
      throw new Error("acknowledgement lost");
    },
  };
  const execute = jest.fn();
  const service = createAskRunService({ repository, execute });
  const accepted = await service.start(input);
  expect(accepted.status).toBe("queued");
  expect((await service.start(input)).runId).toBe(accepted.runId);
  expect(execute).not.toHaveBeenCalled();
  service.dispose();
});

it("prevents an expired owner from completing over a newer request", async () => {
  let now = 1000;
  const repository = createMemoryAskRunRepository();
  let complete!: (value: { result: { answer: string } }) => void;
  const onCompleted = jest.fn();
  const old = createAskRunService({
    repository,
    onCompleted,
    now: () => now,
    leaseMs: 100,
    pollMs: 10000,
    execute: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const newer = createAskRunService({
    repository,
    now: () => now,
    execute: async () => ({
      result: { answer: "New answer" },
      privateState: { history: ["new history"] },
    }),
  });
  const first = await old.start(input);
  await flush();
  now = 1200;
  const second = await newer.start({ ...input, requestId: "new-request" });
  await flush();
  complete({ result: { answer: "Old answer" } });
  await flush();
  expect((await old.get({ ...input, runId: first.runId })).status).toBe(
    "interrupted",
  );
  expect(await newer.get({ ...input, runId: second.runId })).toMatchObject({
    status: "completed",
    text: "New answer",
  });
  expect(await repository.getPrivateState(input)).toEqual({
    history: ["new history"],
  });
  expect(onCompleted).not.toHaveBeenCalled();
  old.dispose();
  newer.dispose();
});

it("preserves completed state and stops heartbeats before projection failure", async () => {
  const repository = createMemoryAskRunRepository();
  const replace = jest.spyOn(repository, "replace");
  let writesBeforeProjection = 0;
  let writesAfterProjection = 0;
  const onCompleted = jest.fn(async () => {
    writesBeforeProjection = replace.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    writesAfterProjection = replace.mock.calls.length;
    throw new Error("projection unavailable");
  });
  const log = jest.spyOn(console, "error").mockImplementation(() => undefined);
  const service = createAskRunService({
    repository,
    onCompleted,
    pollMs: 5,
    execute: async () => ({ result: { answer: "Saved answer" } }),
  });
  try {
    const accepted = await service.start(input);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(writesAfterProjection).toBe(writesBeforeProjection);
    expect(
      await service.get({ ...input, runId: accepted.runId }),
    ).toMatchObject({ status: "completed", text: "Saved answer" });
    expect(
      replace.mock.calls.map(([, next]) => next.snapshot.status),
    ).not.toContain("failed");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("projection failed"),
    );
  } finally {
    service.dispose();
    log.mockRestore();
  }
});
