import { randomUUID, createHash } from "node:crypto";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createIntroduction } from "../../scripts/deployment/introduce-sandbox.cjs";
import { client } from "./fixtures/sandboxBootstrap";
import { repairFixture } from "./fixtures/sandboxRepair";
function expectNoRepairWrites(f: Awaited<ReturnType<typeof repairFixture>>) {
  expect(
    f.calls.some((call) =>
      ["update-service", "transact-write-items"].includes(call.operation),
    ),
  ).toBe(false);
}

test.each(["before", "after"])(
  "repair reconciles completion-only after an uncertain %s acknowledgment",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lostCompletion = kind;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 1 });
    const stops = f.calls.filter(
      (c) => c.operation === "update-service",
    ).length;
    const launches = f.state.updates;
    await expect(
      f.intro.repair(f.previous, f.previousHash),
    ).resolves.toMatchObject({ kind: "complete" });
    expect(await f.get("INTRODUCTION")).toMatchObject({ stage: "complete" });
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: "complete",
    });
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(stops);
    expect(f.state.updates).toBe(launches);
  },
);

test.each(["foreign-lineage", "changed-generation", "stale-runtime"])(
  "completion-only reconciliation refuses %s",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lostCompletion = "before";
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    const sk =
      kind === "foreign-lineage"
        ? "REPAIR#" + f.manifest.operationId
        : kind === "changed-generation"
          ? "CONTROL"
          : "RUNTIME#runtime";
    const row = await f.get(sk);
    if (kind === "foreign-lineage") row!.previousOperationId = randomUUID();
    if (kind === "changed-generation") row!.servingGeneration = 2;
    if (kind === "stale-runtime") row!.readiness.expiresAt = 999;
    await client.send(
      new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
    );
    const writes = f.calls.filter((c) =>
      ["transact-write-items", "update-service"].includes(c.operation),
    ).length;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) =>
        ["transact-write-items", "update-service"].includes(c.operation),
      ),
    ).toHaveLength(writes);
    expect(await f.get("INTRODUCTION")).toMatchObject({
      stage: "routing_acknowledged",
    });
  },
);

test("repair conditionally supersedes an acknowledged failed unserved bootstrap and reuses promotion", async () => {
  const f = await repairFixture();
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  expect(await f.get("BOOTSTRAP#" + f.previous.operationId)).toMatchObject({
    stage: "superseded",
    supersededBy: f.manifest.operationId,
  });
  expect(await f.get("INTRODUCTION")).toMatchObject({
    stage: "complete",
    previousOperationId: f.previous.operationId,
    operationId: f.manifest.operationId,
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "complete",
    previousOperationId: f.previous.operationId,
  });
  expect(await f.get("CONTROL")).toMatchObject({
    servingGeneration: 1,
    coordinatorToken: f.manifest.operationId,
  });
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete" });
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    1,
  );
});

test.each([
  "foreign-owner",
  "serving-member",
  "unacknowledged-launch",
  "live-coordinator",
])("repair refuses %s before writes", async (kind) => {
  const f = await repairFixture();
  const sk =
    kind === "unacknowledged-launch"
      ? "BOOTSTRAP#" + f.previous.operationId
      : "CONTROL";
  const row = await f.get(sk);
  if (kind === "foreign-owner") row!.coordinatorToken = randomUUID();
  if (kind === "serving-member") row!.servingGeneration = 1;
  if (kind === "unacknowledged-launch") row!.stage = "launch_submitted";
  if (kind === "live-coordinator") row!.coordinatorExpiresAt = 2000;
  await client.send(
    new PutItemCommand({ TableName: f.table, Item: marshall(row) }),
  );
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expectNoRepairWrites(f);
});

test.each(["stop", "transfer"])(
  "repair preserves an unknown %s write and never replays",
  async (kind) => {
    const f = await repairFixture();
    if (kind === "stop") f.repairState.lostStop = true;
    else f.repairState.lostTransfer = true;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(1);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: kind === "stop" ? "stop_submitted" : "initialized",
    });
    expect(f.state.updates).toBe(0);
  },
);

test("repair refuses a future maintenance proof before reserving or stopping", async () => {
  const f = await repairFixture();
  const manifest = {
    ...f.manifest,
    maintenance: {
      ...f.manifest.maintenance,
      confirmedAt: new Date(1001_000).toISOString(),
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex");
  const intro = createIntroduction({
    manifest,
    expectedSha256: hash,
    aws: f.repairAws,
    bootstrap: f.bootstrap,
    now: () => 1000,
    pause: async () => undefined,
  });
  await expect(intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expectNoRepairWrites(f);
});

test("repair reservation condition rejects coordinator changes after its read", async () => {
  const f = await repairFixture();
  f.repairState.raceReservation = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    0,
  );
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toBeUndefined();
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.previous.operationId,
    coordinatorExpiresAt: 2000,
  });
});

test("repair rechecks the stop budget after a slow intent acknowledgment", async () => {
  const f = await repairFixture();
  f.repairState.slowIntent = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(f.calls.filter((c) => c.operation === "update-service")).toHaveLength(
    0,
  );
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "stop_submitted",
  });
});

test("repair rechecks maintenance after slow final reads before ownership transfer", async () => {
  const f = await repairFixture();
  f.repairState.slowTransfer = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(
    f.calls.filter((c) => c.operation === "transact-write-items"),
  ).toHaveLength(1);
  expect(await f.get("CONTROL")).toMatchObject({
    coordinatorToken: f.previous.operationId,
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "stop_acknowledged",
  });
});

test.each(["protected", "foreign-target"])(
  "repair refuses %s before reservation and shutdown",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.oldTask = "live";
    f.repairState.protectedTask = kind === "protected";
    f.repairState.foreignTarget = kind === "foreign-target";
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expectNoRepairWrites(f);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toBeUndefined();
  },
);

test.each(["live", "stopped"])(
  "repair accounts for exact owned %s task targets",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.oldTask = kind;
    await expect(
      f.intro.repair(f.previous, f.previousHash),
    ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  },
);

test.each(["protected", "foreign-target"])(
  "repair revalidates late %s at the stop boundary",
  async (kind) => {
    const f = await repairFixture();
    f.repairState.lateTopology = kind;
    await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
    expect(
      f.calls.filter((c) => c.operation === "update-service"),
    ).toHaveLength(0);
    expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
      stage: "stop_submitted",
    });
  },
);

test("repair completion conditions preserve both receipts when ownership changes", async () => {
  const f = await repairFixture();
  f.repairState.raceCompletion = true;
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expect(await f.get("INTRODUCTION")).toMatchObject({
    stage: "routing_acknowledged",
  });
  expect(await f.get("REPAIR#" + f.manifest.operationId)).toMatchObject({
    stage: "foreign",
  });
  expect(await f.get("CONTROL")).toMatchObject({ servingGeneration: 1 });
});

test("repair permits native cleanup only after all containers have stopped", async () => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
});

test.each([
  "running-container",
  "unknown-desired",
  "missing-containers",
  "healthy-target",
])("repair refuses inconsistent cleanup %s before writes", async (kind) => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  if (kind === "running-container") f.repairState.containerStatus = "RUNNING";
  if (kind === "unknown-desired") f.repairState.desiredTaskStatus = "RUNNING";
  if (kind === "missing-containers") f.repairState.missingContainers = true;
  if (kind === "healthy-target") f.repairState.targetState = "healthy";
  await expect(f.intro.repair(f.previous, f.previousHash)).rejects.toThrow();
  expectNoRepairWrites(f);
});

test("repair waits for exited task cleanup before launching the replacement", async () => {
  const f = await repairFixture();
  f.repairState.oldTask = "deprovisioning";
  f.repairState.protectedTask = true;
  f.repairState.holdTaskAfterStop = true;
  await expect(
    f.intro.repair(f.previous, f.previousHash),
  ).resolves.toMatchObject({ kind: "complete", generation: 1 });
  expect(f.repairState.waits).toBe(1);
});
