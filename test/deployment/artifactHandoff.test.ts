/** @jest-environment node */
import * as artifactTypes from "../../src/types/artifactSafety";
import * as artifactBuilders from "../../src/services/artifactSafetyTransactions";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { artifactSafetyFixture } from "./fixtures/artifactSafetyFixture";
import { attestation } from "./fixtures/legacyArtifactFixture";
import { createArtifactHandoff } from "../../scripts/deployment/artifact-handoff.cjs";
import { guardedCoordinator } from "../../scripts/deployment/sandbox-operation.cjs";
import { CoordinatorFailure } from "../../scripts/deployment/coordinator-aws.cjs";
import { fixture as coordinatorFixture } from "./fixtures/coordinatorFixture";
import { introductionFixture } from "../fixtures/productionIntroduction";

function fixture(
  now = () => 120,
  beforeWrite: (input: TransactWriteItemsCommandInput) => void = () => {},
) {
  const f = artifactSafetyFixture();
  let row: artifactTypes.ArtifactSafetyRecord | undefined = f.expected;
  const aws = jest.fn(async (_service, operation, input) => {
    if (operation === "get-item")
      return { Item: row ? marshall(row) : undefined };
    beforeWrite(input);
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

function delayedConsume(
  f: ReturnType<typeof coordinatorFixture>,
  seconds: number,
) {
  let elapsed = 0;
  const now = () => f.options.now() + elapsed;
  return {
    now,
    coordinator: guardedCoordinator(
      { ...f.options, now },
      async (operation) => {
        if (
          operation === "transact-write-items" &&
          f.state.artifacts.get("old")!.state === "sealed"
        )
          elapsed += seconds;
      },
    ),
  };
}

function promotionHeartbeat(f: ReturnType<typeof coordinatorFixture>) {
  f.advanceTime(10);
  for (const [id, row] of f.state.artifacts)
    f.state.artifacts.set(id, { ...row, revision: row.revision + 1 });
}

test.each([false, true])(
  "authority refusal preserves classification, typed %s",
  async (typed) => {
    const f = coordinatorFixture();
    await f.coordinator.prepare();
    const before = f.calls.length;
    const failure = typed
      ? new CoordinatorFailure(
          "fixture_authority_refused",
          "private",
          "fixture.guard",
        )
      : new Error("PRIVATE_GUARD_PAYLOAD");
    const coordinator = guardedCoordinator(f.options, async (operation) => {
      if (operation === "transact-write-items") throw failure;
    });
    const error = await coordinator.promote().catch((caught) => caught);
    if (typed) expect(error).toBe(failure);
    else
      expect(error).toMatchObject({
        category: "operation_authority_unconfirmed",
        operation: "dynamodb.transact-write-items",
      });
    expect(error.message).not.toContain("PRIVATE_GUARD_PAYLOAD");
    expect(
      f.calls
        .slice(before)
        .filter((call) =>
          [
            "transact-write-items",
            "register-task-definition",
            "update-service",
            "modify-listener",
          ].includes(call.operation),
        ),
    ).toEqual([]);
    expect(f.state.ctl.servingGeneration).toBe(1);
  },
);

test("guarded preparation snapshots artifact CAS after authority latency and heartbeat", async () => {
  const f = coordinatorFixture();
  const original = f.aws.getMockImplementation()!;
  const attemptedRevisions: number[] = [];
  let guards = 0;
  f.aws.mockImplementation(async (service, operation, input) => {
    const put = input.TransactItems?.[0]?.Put;
    if (operation === "transact-write-items" && put) {
      const names = put.ExpressionAttributeNames!;
      const revisionName = Object.keys(names).find(
        (key) => names[key] === "revision",
      )!;
      const clause = put
        .ConditionExpression!.split(" AND ")
        .find((part) => part.startsWith(revisionName + " = "))!;
      const expected = unmarshall(put.ExpressionAttributeValues!)[
        clause.split(" = ")[1]
      ];
      const row = f.state.artifacts.get("old")!;
      attemptedRevisions.push(expected);
      if (expected !== row.revision)
        throw Error("TransactionCanceledException: stale artifact revision");
    }
    return original(service, operation, input);
  });
  const coordinator = guardedCoordinator(f.options, async (operation) => {
    const row = f.state.artifacts.get("old")!;
    if (operation !== "transact-write-items" || row.state !== "idle") return;
    guards++;
    const startup = structuredClone(row.startup);
    f.advanceTime(10);
    f.state.artifacts.set("old", {
      ...f.state.artifacts.get("old")!,
      revision: row.revision + 1,
      startup,
    });
  });
  const result = await coordinator.prepare().catch((error) => error);
  expect({ kind: result.kind, guards, attemptedRevisions }).toEqual({
    kind: "warming",
    guards: 1,
    attemptedRevisions: [1, 3],
  });
  expect(f.svc.taskDefinition).toBe("definition:new");
});

test.each(["startup", "revision_rollback"])(
  "guarded preparation refuses %s drift before submitting an artifact transaction",
  async (change) => {
    const f = coordinatorFixture();
    const initial = f.state.artifacts.get("old")!;
    f.state.artifacts.set("old", { ...initial, revision: 5 });
    const coordinator = guardedCoordinator(f.options, async (operation) => {
      if (operation !== "transact-write-items") return;
      const row = f.state.artifacts.get("old")!;
      f.state.artifacts.set("old", {
        ...row,
        ...(change === "startup"
          ? { startup: { kind: "active", activatedAt: f.options.now() + 1 } }
          : { revision: row.revision - 1 }),
      });
    });
    await expect(coordinator.prepare()).rejects.toMatchObject({
      category: "artifact_preservation_unconfirmed",
    });
    expect(
      f.calls.some((call) =>
        ["transact-write-items", "update-service"].includes(call.operation),
      ),
    ).toBe(false);
  },
);

test("promotion snapshots artifact conditions after its full authority guard", async () => {
  const f = coordinatorFixture();
  await f.coordinator.prepare();
  const original = f.aws.getMockImplementation()!;
  let submitted = 0;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (
      operation === "transact-write-items" &&
      input.TransactItems?.[0]?.Update
    ) {
      submitted++;
      for (const item of input.TransactItems) {
        const check = item.ConditionCheck;
        if (!check) continue;
        const names = check.ExpressionAttributeNames;
        const revision = Object.keys(names).find(
          (key) => names[key] === "revision",
        );
        if (!revision) continue;
        const value = check.ConditionExpression.split(" AND ")
          .find((clause) => clause.startsWith(revision + " = "))!
          .split(" = ")[1];
        const identity = unmarshall(check.Key)
          .sk.substring("ARTIFACTS#".length)
          .split("/")[0];
        if (
          unmarshall(check.ExpressionAttributeValues)[value] !==
          f.state.artifacts.get(identity)!.revision
        )
          throw Object.assign(
            new Error("conditional artifact snapshot changed"),
            {
              name: "TransactionCanceledException",
              CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
            },
          );
      }
    }
    return original(service, operation, input);
  });
  const coordinator = guardedCoordinator(f.options, async (operation) => {
    if (operation === "transact-write-items") {
      promotionHeartbeat(f);
    }
  });
  await expect(coordinator.promote()).resolves.toEqual({ kind: "promoted" });
  expect(submitted).toBe(1);
});

test.each([
  "source_request",
  "candidate_identity",
  "candidate_snapshot",
  "proof_rollback",
  "revision_rollback",
])(
  "promotion refuses %s drift during authority before submission",
  async (change) => {
    const f = coordinatorFixture();
    await f.coordinator.prepare();
    const before = f.calls.length;
    const coordinator = guardedCoordinator(f.options, async (operation) => {
      if (operation !== "transact-write-items") return;
      const row = f.state.artifacts.get("old")!;
      if (change === "source_request" && row.state === "consumed")
        row.request.expiresAt++;
      if (change === "revision_rollback") row.revision--;
      if (change === "candidate_identity")
        f.state.artifacts.get("new")!.identity.candidateId = "foreign";
      const target = f.state.artifacts.get("new")!;
      if (target.startup.kind === "sealed") {
        if (change === "candidate_snapshot")
          target.startup.proof.snapshot.digest = "f".repeat(64);
        if (change === "proof_rollback") {
          target.startup.proof.provenAt--;
          target.startup.proof.expiresAt--;
        }
      }
    });
    await expect(coordinator.promote()).rejects.toThrow();
    expect(
      f.calls
        .slice(before)
        .filter((call) => call.operation === "transact-write-items"),
    ).toEqual([]);
    expect(f.state.ctl.servingGeneration).toBe(1);
  },
);

test("guarded promotion reconciles a lost acknowledgment after authority latency", async () => {
  const f = coordinatorFixture();
  await f.coordinator.prepare();
  f.state.losePromotionResponse = true;
  let guards = 0;
  const coordinator = guardedCoordinator(f.options, async (operation) => {
    if (operation === "transact-write-items") {
      guards++;
      promotionHeartbeat(f);
    }
  });
  await expect(coordinator.promote()).resolves.toEqual({ kind: "promoted" });
  expect(guards).toBe(1);
  expect(f.state.ctl.servingMembers).toEqual({
    new: f.state.rows.new.identity,
  });
  expect(f.state.ctl.servingGeneration).toBe(2);
});

test("rejected artifact authority never submits its transaction", async () => {
  const f = coordinatorFixture();
  const coordinator = guardedCoordinator(f.options, async (operation) => {
    if (operation === "transact-write-items") throw Error("authority refused");
  });
  await expect(coordinator.prepare()).rejects.toMatchObject({
    category: "operation_authority_unconfirmed",
    operation: "dynamodb.transact-write-items",
  });
  expect(
    f.calls.some((call) =>
      ["transact-write-items", "update-service"].includes(call.operation),
    ),
  ).toBe(false);
});

test.each(["prepare", "promote"] as const)(
  "an introduction hold during %s authority prevents submission",
  async (phase) => {
    const f = coordinatorFixture();
    if (phase === "promote") await f.coordinator.prepare();
    const before = f.calls.length;
    const expectedArtifact = structuredClone(f.state.artifacts.get("old"));
    const original = f.aws.getMockImplementation()!;
    let held = false;
    f.aws.mockImplementation(async (service, operation, input) => {
      if (
        held &&
        operation === "get-item" &&
        input.Key?.sk?.S === "INTRODUCTION"
      )
        return {
          Item: marshall(
            introductionFixture({
              holdId: "hold",
              introductionId: "intro",
              revision: 1,
            }),
          ),
        };
      return original(service, operation, input);
    });
    const coordinator = guardedCoordinator(f.options, async (operation) => {
      if (operation === "transact-write-items") held = true;
    });
    await expect(coordinator[phase]()).rejects.toMatchObject({
      category: "introduction_held",
    });
    expect(
      f.calls
        .slice(before)
        .some((call) =>
          ["transact-write-items", "update-service"].includes(call.operation),
        ),
    ).toBe(false);
    expect(f.state.artifacts.get("old")).toEqual(expectedArtifact);
  },
);

test("guarded artifact provider errors retain coordinator classification", async () => {
  const f = coordinatorFixture();
  const original = f.aws.getMockImplementation()!;
  let transactions = 0;
  f.aws.mockImplementation(async (service, operation, input) => {
    if (operation === "transact-write-items") {
      transactions++;
      throw Object.assign(Error("conditional conflict"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
    }
    return original(service, operation, input);
  });
  const coordinator = guardedCoordinator(f.options, async () => {});
  await expect(coordinator.prepare()).rejects.toMatchObject({
    category: "control_store_condition_failed",
    operation: "dynamodb.transact-write-items",
  });
  expect(transactions).toBe(1);
  expect(f.calls.some((call) => call.operation === "update-service")).toBe(
    false,
  );
});

test("guarded consume reconciles a lost acknowledgment at its actual submitted time", async () => {
  const f = coordinatorFixture();
  const original = f.aws.getMockImplementation()!;
  let lost = false;
  f.aws.mockImplementation(async (service, operation, input) => {
    const result = await original(service, operation, input);
    const put = input.TransactItems?.[0]?.Put;
    if (put && unmarshall(put.Item!).state === "consumed" && !lost) {
      lost = true;
      throw Error("lost consume response");
    }
    return result;
  });
  const { coordinator, now } = delayedConsume(f, 10);
  await expect(coordinator.prepare()).resolves.toEqual({ kind: "warming" });
  expect(lost).toBe(true);
  expect(f.state.artifacts.get("old")).toMatchObject({
    state: "consumed",
    consumedAt: now(),
  });
  expect(f.state.ctl.deployment!.updatedAt).toBe(now());
});

test("guard latency cannot extend an expired artifact seal", async () => {
  const f = coordinatorFixture();
  const { coordinator } = delayedConsume(f, 61);
  await expect(coordinator.prepare()).rejects.toThrow(
    "Artifact proof cannot be consumed",
  );
  expect(f.state.artifacts.get("old")!.state).toBe("sealed");
  expect(f.calls.some((call) => call.operation === "update-service")).toBe(
    false,
  );
});

test("request retries a heartbeat conflict without adding history checks", async () => {
  let writes = 0;
  const f = fixture(
    () => 120,
    (input) => {
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
    },
  );
  f.setRow(idle(f));
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
    let writes = 0;
    const f = fixture(
      () => 120,
      () => {
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
      },
    );
    f.setRow(idle(f));
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

describe.each(["consume", "cancel"])("%s heartbeat retry", (operation) => {
  test.each(["heartbeat", "proof", "request", "control", "role", "exhausted"])(
    "handles a concurrent %s change without runtime mutation",
    async (change) => {
      let attempts = 0;
      const f = fixture(
        () => 120,
        () => {
          attempts++;
          if (attempts > 1 && change !== "exhausted") return;
          const row = artifactTypes.artifactSafetyRecordSchema.parse({
            ...f.expected,
            revision: f.getRow()!.revision + 1,
            heartbeatAt: 120,
            freshUntil: 180,
            ...(change === "proof"
              ? { proof: { ...f.expected.proof, provenAt: 111 } }
              : {}),
            ...(change === "request"
              ? { request: { ...f.expected.request, expiresAt: 301 } }
              : {}),
          });
          f.setRow(row);
          if (change === "control") f.ctl.coordinatorEpoch++;
          if (change === "role") f.source.role = "draining";
          throw new Error("TransactionCanceledException");
        },
      );
      const result =
        operation === "consume"
          ? f.helper.prepare(f.ctl)
          : f.helper.cancel(f.ctl);
      if (change === "heartbeat") {
        await result;
        expect(attempts).toBe(2);
        expect(f.getRow()?.state).toBe(
          operation === "consume" ? "consumed" : "cancel_requested",
        );
      } else {
        await expect(result).rejects.toThrow();
        expect(attempts).toBe(change === "exhausted" ? 3 : 1);
        expect(f.getRow()?.state).toBe("sealed");
      }
      expect(
        f.aws.mock.calls.every(
          ([service, action]) =>
            service === "dynamodb" &&
            ["get-item", "transact-write-items"].includes(action),
        ),
      ).toBe(true);
    },
  );
});
