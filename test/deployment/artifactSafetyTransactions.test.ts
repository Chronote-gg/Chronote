/** @jest-environment node */
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { buildArtifactSafetyTransaction } from "../../src/services/artifactSafetyTransactions";
import {
  artifactSafetyRecordSchema,
  artifactSafetyBaseSchema,
} from "../../src/types/artifactSafety";
import { runtime } from "./controlFixtures";
import { artifactSafetyFixture as fixture } from "./fixtures/artifactSafetyFixture";

function unfinishedStartup(f: ReturnType<typeof fixture>) {
  return artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    state: "idle",
    startup: { kind: "pending" },
  });
}

test("proof consumption and warming commit atomically without adding Control fields", () => {
  const f = fixture();
  const next = {
    ...f.expected,
    revision: 3,
    state: "consumed" satisfies "consumed",
    consumedAt: 120,
  };
  const transaction = buildArtifactSafetyTransaction(
    {
      purpose: "consume",
      expected: f.expected,
      next,
      context: { kind: "preparing", control: f.ctl, runtime: f.source },
      now: 120,
    },
    f.tables,
  );
  const items = transaction.TransactItems!;
  const controlUpdate = items.find(
    (item) => item.Update?.TableName === "control",
  );
  expect(unmarshall(controlUpdate!.Update!.Key)).toEqual({
    pk: "ENV",
    sk: "CONTROL",
  });
  const values = unmarshall(controlUpdate!.Update!.ExpressionAttributeValues!);
  expect(Object.values(values)).toContainEqual(f.ctl.deployment);
  expect(values[":nextDeployment"]).toEqual({
    ...f.ctl.deployment,
    phase: "warming",
    updatedAt: 120,
  });
  expect(
    items.some(
      (item) => item.Put && unmarshall(item.Put.Item).state === "consumed",
    ),
  ).toBe(true);
  const keys = items.map((item) => {
    const operation = item.Update ?? item.ConditionCheck;
    return JSON.stringify(
      operation
        ? [operation.TableName, unmarshall(operation.Key)]
        : [item.Put!.TableName, unmarshall(item.Put!.Item).sk],
    );
  });
  expect(new Set(keys).size).toBe(items.length);
});

test.each(["expired", "token", "generation", "source"])(
  "%s refuses consumption",
  (reason) => {
    const f = fixture();
    const next = {
      ...f.expected,
      revision: 3,
      state: "consumed" satisfies "consumed",
      consumedAt: 120,
    };
    if (reason === "token") f.ctl.coordinatorToken = "changed";
    if (reason === "generation") f.ctl.servingGeneration++;
    if (reason === "source")
      f.ctl.servingMembers = { different: runtime("different").identity };
    expect(() =>
      buildArtifactSafetyTransaction(
        {
          purpose: "consume",
          expected: f.expected,
          next,
          context: { kind: "preparing", control: f.ctl, runtime: f.source },
          now: reason === "expired" ? 171 : 120,
        },
        f.tables,
      ),
    ).toThrow();
  },
);

test("cancellation cannot reopen a source after warming may have launched", () => {
  const f = fixture();
  f.ctl.deployment!.phase = "warming";
  const next = artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    request: f.expected.request,
    revision: 3,
    state: "cancel_requested",
  });
  expect(() =>
    buildArtifactSafetyTransaction(
      {
        purpose: "cancel",
        expected: f.expected,
        next,
        context: { kind: "preparing", control: f.ctl, runtime: f.source },
        now: 120,
      },
      f.tables,
    ),
  ).toThrow();
});

test("cancellation acknowledgment closes preparing atomically under the exact control snapshot", () => {
  const f = fixture();
  const expected = artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    state: "cancel_requested",
    request: f.expected.request,
  });
  const next = artifactSafetyRecordSchema.parse({
    ...expected,
    revision: expected.revision + 1,
    state: "cancelled",
    cancelledAt: 120,
    heartbeatAt: 120,
    freshUntil: 180,
  });
  const transaction = buildArtifactSafetyTransaction(
    {
      purpose: "cancel_ack",
      expected,
      next,
      context: { kind: "preparing", control: f.ctl, runtime: f.source },
      now: 120,
    },
    f.tables,
  );
  const update = transaction.TransactItems?.find((item) => item.Update)?.Update;
  expect(update).toBeDefined();
  const values = unmarshall(update!.ExpressionAttributeValues!);
  expect(Object.values(values)).toContainEqual(f.ctl.deployment);
  expect(values[":nextDeployment"]).toEqual({
    ...f.ctl.deployment,
    phase: "complete",
    updatedAt: 120,
  });
});

test("startup cannot claim activation without a sealed storage proof", () => {
  const f = fixture();
  const expected = unfinishedStartup(f);
  const next = artifactSafetyRecordSchema.parse({
    ...expected,
    revision: 3,
    heartbeatAt: 120,
    freshUntil: 180,
    startup: { kind: "active", activatedAt: 120 },
  });
  expect(() =>
    buildArtifactSafetyTransaction(
      {
        purpose: "startup",
        expected,
        next,
        context: {
          kind: "runtime",
          runtime: { ...f.source, role: "candidate" },
        },
        now: 120,
      },
      f.tables,
    ),
  ).toThrow();
});

test("a coordinator request cannot upgrade an unfinished startup into active capability", () => {
  const f = fixture();
  const expected = unfinishedStartup(f);
  const next = artifactSafetyRecordSchema.parse({
    ...artifactSafetyBaseSchema.parse(f.expected),
    revision: 3,
    state: "requested",
    request: { ...f.expected.request, requestedAt: 120 },
    startup: { kind: "active", activatedAt: 120 },
  });
  expect(() =>
    buildArtifactSafetyTransaction(
      {
        purpose: "request",
        expected,
        next,
        context: { kind: "preparing", control: f.ctl, runtime: f.source },
        now: 120,
      },
      f.tables,
    ),
  ).toThrow();
});
