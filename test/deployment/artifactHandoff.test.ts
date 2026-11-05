/** @jest-environment node */
import * as artifactTypes from "../../src/types/artifactSafety";
import * as artifactBuilders from "../../src/services/artifactSafetyTransactions";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { attestation } from "./fixtures/legacyArtifactFixture";
import { createArtifactHandoff } from "../../scripts/deployment/artifact-handoff.cjs";

function fixture(now = () => 120) {
  const f = artifactSafetyFixture();
  let row: artifactTypes.ArtifactSafetyRecord | undefined = f.expected;
  const aws = jest.fn(async (_service, operation, input) => {
    if (operation === "get-item")
      return { Item: row ? marshall(row) : undefined };
    row = artifactTypes.artifactSafetyRecordSchema.parse(
      unmarshall(input.TransactItems[0].Put.Item),
    );
    if (row.state === "consumed")
      f.ctl = artifactBuilders.artifactPreparationControl(
        f.ctl,
        120,
        "warming",
      );
    return {};
  });
  const options = {
    artifactTypes,
    artifactBuilders,
    aws,
    tables: f.tables,
    now,
    runtime: async () => f.source,
    control: async () => f.ctl,
    renew: async () => f.ctl,
    protectedTask: async () => ({
      expirationDate: new Date(600_000).toISOString(),
    }),
    sleep: async () => {
      throw new Error("unexpected wait");
    },
    production: undefined,
    assertWriter: async () => {},
    own: () => {},
    service: async () => ({ taskDefinition: "previous" }),
    tasks: async () => [],
  };
  const helper = createArtifactHandoff(options);
  return {
    ...f,
    helper,
    aws,
    options,
    getRow: () => row,
    setRow: (value: artifactTypes.ArtifactSafetyRecord | undefined) => {
      row = value;
    },
  };
}

test("consumes the exact sealed proof together with warming before launch", async () => {
  const f = fixture();
  expect((await f.helper.prepare(f.ctl)).deployment.phase).toBe("warming");
  expect(
    f.aws.mock.calls.filter((call) => call[1] === "transact-write-items"),
  ).toHaveLength(1);
  await expect(
    f.helper.committed(
      await f.helper.prepare({
        ...f.ctl,
        deployment: { ...f.ctl.deployment, phase: "warming" },
      }),
    ),
  ).resolves.toBeDefined();
});

function idle(f: ReturnType<typeof fixture>) {
  return artifactTypes.artifactSafetyRecordSchema.parse({
    ...artifactTypes.artifactSafetyBaseSchema.parse(f.expected),
    state: "idle",
  });
}

test("request retries a heartbeat conflict without adding history checks", async () => {
  const f = fixture();
  f.setRow(idle(f));
  const original = f.aws.getMockImplementation()!;
  let writes = 0;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation !== "transact-write-items")
      return original(service, operation, input);
    expect(input.TransactItems).toHaveLength(3);
    if (++writes === 1) {
      const row = f.getRow()!;
      f.setRow({
        ...row,
        revision: row.revision + 1,
        heartbeatAt: 120,
        freshUntil: 180,
      });
      throw new Error("TransactionCanceledException");
    }
    return original(service, operation, input);
  });
  // Stop after the real request path, before the runtime's separate drain/seal.
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow("unexpected wait");
  expect(writes).toBe(2);
  expect(f.getRow()?.state).toBe("requested");
});

test("an idle unrequested preparation can cancel without changing the artifact row", async () => {
  const f = fixture();
  const row = idle(f);
  f.setRow(row);
  const original = f.aws.getMockImplementation()!;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation !== "transact-write-items")
      return original(service, operation, input);
    expect(input.TransactItems).toHaveLength(3);
    expect(input.TransactItems.every((item) => !item.Put)).toBe(true);
    f.ctl.deployment = {
      ...f.ctl.deployment!,
      phase: "complete",
      updatedAt: 120,
    };
    return {};
  });
  await expect(f.helper.cancelPreparation()).resolves.toEqual({
    kind: "cancelled",
  });
  expect(f.getRow()).toEqual(row);
  expect(f.ctl.deployment?.phase).toBe("complete");
});

test.each(["unchanged", "startup", "exhausted"])(
  "request refuses a conflict that is %s",
  async (change) => {
    const f = fixture();
    f.setRow(idle(f));
    const original = f.aws.getMockImplementation()!;
    let writes = 0;
    f.aws.mockImplementation(async (service, operation, input) => {
      if (operation !== "transact-write-items")
        return original(service, operation, input);
      writes++;
      const row = f.getRow()!;
      if (change !== "unchanged")
        f.setRow({
          ...row,
          revision: row.revision + 1,
          ...(change === "startup"
            ? { startup: { kind: "active", activatedAt: 91 } }
            : {}),
        });
      throw new Error("conflict");
    });
    await expect(f.helper.prepare(f.ctl)).rejects.toThrow("conflict");
    expect(writes).toBe(change === "exhausted" ? 3 : 1);
    expect(f.getRow()?.state).toBe("idle");
  },
);

test.each([
  "warming",
  "service",
  "candidate",
  "runtime",
  "expired",
  "startup",
  "protection",
])(
  "idle cancellation refuses changed %s before a transaction",
  async (change) => {
    const f = fixture();
    f.ctl.deployment!.taskDefinition = "candidate";
    f.setRow(idle(f));
    if (change === "warming") f.ctl.deployment!.phase = "warming";
    if (change === "runtime") f.source.authorizedGeneration++;
    if (change === "expired")
      f.setRow({ ...idle(f), heartbeatAt: 50, freshUntil: 110 });
    if (change === "startup")
      f.setRow({ ...idle(f), startup: { kind: "pending" } });
    const helper = createArtifactHandoff({
      ...f.options,
      service: async () => ({
        taskDefinition: change === "service" ? "candidate" : "previous",
      }),
      tasks: async () =>
        change === "candidate" ? [{ taskDefinitionArn: "candidate" }] : [],
      protectedTask: async () => {
        if (change === "protection") throw new Error("unprotected");
        return { expirationDate: new Date(600_000).toISOString() };
      },
    });
    await expect(helper.cancelPreparation()).rejects.toThrow();
    expect(
      f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
    ).toBe(false);
  },
);

test("consumption stays bound to one clock reading across a slow runtime read", async () => {
  let clock = 120;
  const f = fixture(() => clock++);
  expect((await f.helper.prepare(f.ctl)).deployment.phase).toBe("warming");
});

test("legacy capability refuses, including an emergency quiet override", async () => {
  const f = fixture();
  f.setRow(undefined);
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow(/capability/);
  expect(
    f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
  ).toBe(false);
});

test("cancel is only legal before atomic proof consumption", async () => {
  const f = fixture();
  const warming = await f.helper.prepare(f.ctl);
  await expect(f.helper.cancel(warming)).rejects.toThrow();
});

test("a candidate needs its own fresh sealed startup proof", async () => {
  const f = fixture();
  await expect(f.helper.candidate(f.source.identity)).rejects.toThrow(
    /startup/,
  );
});

function attestedConsumed(f: ReturnType<typeof fixture>) {
  return artifactTypes.artifactSafetyRecordSchema.parse({
    ...f.expected,
    revision: 3,
    startup: { kind: "pending" },
    state: "consumed",
    consumedAt: 120,
    attestation: { ...attestation, verifiedAt: 100 },
  });
}

test("an attested legacy source reports operator evidence, not a runtime proof", async () => {
  const f = fixture();
  f.setRow(attestedConsumed(f));
  await expect(f.helper.sourceEvidence(f.ctl)).resolves.toBe(
    "operator_attested_legacy",
  );
  f.setRow(f.expected);
  await f.helper.prepare(f.ctl);
  await expect(f.helper.sourceEvidence(f.ctl)).resolves.toBe(
    "verified_at_launch",
  );
});

test("retirement accepts an attested legacy source that cannot verify itself", async () => {
  const f = fixture();
  const acknowledgment = {
    request: {
      identity: f.source.identity,
      authorizedGeneration: 7,
      coordinatorToken: "coordinator",
      coordinatorEpoch: 3,
    },
    retiredAt: 130,
  };
  f.setRow(attestedConsumed(f));
  await expect(
    f.helper.retired(f.source.identity, acknowledgment),
  ).resolves.toBeUndefined();
  f.setRow(
    artifactTypes.artifactSafetyRecordSchema.parse({
      ...f.expected,
      revision: 3,
      state: "consumed",
      consumedAt: 120,
    }),
  );
  await expect(
    f.helper.retired(f.source.identity, acknowledgment),
  ).rejects.toThrow(/verification/);
});

test("an expired attestation refuses before any request is written", async () => {
  const f = fixture();
  const rest = artifactTypes.artifactSafetyBaseSchema.parse(
    attestedConsumed(f),
  );
  f.setRow(
    artifactTypes.artifactSafetyRecordSchema.parse({
      ...rest,
      state: "attested_legacy",
      attestation: {
        ...rest.attestation,
        capturedAt: 0,
        verifiedAt: 0,
        expiresAt: 100,
      },
    }),
  );
  await expect(f.helper.prepare(f.ctl)).rejects.toThrow(/attestation expired/);
  expect(
    f.aws.mock.calls.some((call) => call[1] === "transact-write-items"),
  ).toBe(false);
});
