import type {
  LegacyRow,
  WorkerRecord,
  WorkerRegistryRepository,
} from "../../src/repositories/workerRegistryRepository";

export interface WorkerRegistryHarness {
  repository: WorkerRegistryRepository;
  seedLegacy(row: LegacyRow): Promise<void>;
  dispose?(): Promise<void>;
}

const NOW = 1_000_000;

export function workerRecord(
  instanceId: string,
  overrides: Partial<WorkerRecord> = {},
): WorkerRecord {
  return {
    pk: "WORKERS",
    sk: `WORKER#${instanceId}`,
    recordType: "worker",
    instanceId,
    release: 1,
    ready: true,
    heartbeatAt: NOW,
    captures: 0,
    finishing: 0,
    expiresAt: NOW + 1,
    ...overrides,
  };
}

export function workerRegistryContract(
  make: () => Promise<WorkerRegistryHarness>,
) {
  let h: WorkerRegistryHarness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(async () => {
    await h.dispose?.();
  });

  it("reads an empty registry without a cutover", async () => {
    await expect(h.repository.read()).resolves.toEqual({
      workers: [],
      cutover: false,
    });
  });

  it("put replaces the worker's item unconditionally", async () => {
    await h.repository.put(workerRecord("synthetic-a", { ready: false }));
    const latest = workerRecord("synthetic-a", {
      heartbeatAt: NOW + 10,
      captures: 2,
      finishing: 1,
      protectedUntil: NOW + 600,
      taskArn: "arn:aws:ecs:us-east-1:000000000000:task/synthetic/a",
    });
    await h.repository.put(latest);
    await h.repository.put(workerRecord("synthetic-b", { release: 2 }));
    const view = await h.repository.read();
    expect(view.cutover).toBe(false);
    expect([...view.workers].sort((a, b) => a.sk.localeCompare(b.sk))).toEqual([
      latest,
      workerRecord("synthetic-b", { release: 2 }),
    ]);
  });

  it("omits optional attributes that are absent", async () => {
    await h.repository.put(workerRecord("synthetic-a"));
    const [read] = (await h.repository.read()).workers;
    expect(read).not.toHaveProperty("protectedUntil");
    expect(read).not.toHaveProperty("taskArn");
  });

  it("cutover is permanent and a second write is a success", async () => {
    await h.repository.put(workerRecord("synthetic-a"));
    await h.repository.writeCutover("synthetic-a", NOW);
    await expect(
      h.repository.writeCutover("synthetic-b", NOW + 1),
    ).resolves.toBeUndefined();
    await expect(h.repository.read()).resolves.toEqual({
      workers: [workerRecord("synthetic-a")],
      cutover: true,
    });
  });

  it("legacy heartbeats come only from numeric old runtime rows", async () => {
    await h.seedLegacy({
      pk: "ENV",
      sk: "RUNTIME#synthetic-old",
      heartbeatAt: NOW,
    });
    await h.seedLegacy({
      pk: "ENV",
      sk: "RUNTIME#synthetic-older",
      heartbeatAt: NOW - 500,
    });
    await h.seedLegacy({ pk: "ENV", sk: "RUNTIME#synthetic-missing" });
    await h.seedLegacy({
      pk: "ENV",
      sk: "RUNTIME#synthetic-text",
      heartbeatAt: "not-a-number",
    });
    await h.seedLegacy({ pk: "ENV", sk: "CONTROL", heartbeatAt: NOW + 5 });
    await h.repository.put(workerRecord("synthetic-a"));
    const heartbeats = await h.repository.legacyHeartbeats();
    expect([...heartbeats].sort((a, b) => a - b)).toEqual([NOW - 500, NOW]);
  });

  it("reports no legacy heartbeats in a fresh environment", async () => {
    await expect(h.repository.legacyHeartbeats()).resolves.toEqual([]);
  });
}
