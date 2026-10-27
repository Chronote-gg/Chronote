import { test, expect } from "@jest/globals";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  completeItemSizeBound,
  snapshotCondition,
  assertTransactionCapacity,
} from "../../src/services/productionAcceptanceConditions";

test("snapshot guard binds both present and absent optional runtime fields", () => {
  const row = {
    pk: "ENV",
    sk: "RUNTIME#owner",
    role: "serving",
    workCounts: { pending_admission: 0 },
  };
  const guard = snapshotCondition("control", { pk: row.pk, sk: row.sk }, row, [
    "role",
    "workCounts",
    "retirementRequest",
  ]);
  expect(guard.ExpressionAttributeNames).toEqual({
    "#f0": "role",
    "#f1": "workCounts",
    "#f2": "retirementRequest",
  });
  expect(guard.ConditionExpression).toBe(
    "#f0 = :v0 AND #f1 = :v1 AND attribute_not_exists(#f2)",
  );
  expect(unmarshall(guard.ExpressionAttributeValues!)).toEqual({
    ":v0": "serving",
    ":v1": { pending_admission: 0 },
  });
});

test("capacity refuses duplicate transaction targets and more than 100 targets", () => {
  const check = (n: number) => ({
    ConditionCheck: {
      TableName: "control",
      Key: marshall({ pk: "ENV", sk: String(n) }),
      ConditionExpression: "attribute_exists(pk)",
    },
  });
  expect(() =>
    assertTransactionCapacity({ TransactItems: [check(1), check(1)] }),
  ).toThrow("acceptance_capacity_refused");
  expect(() =>
    assertTransactionCapacity({
      TransactItems: Array.from({ length: 101 }, (_, n) => check(n)),
    }),
  ).toThrow("acceptance_capacity_refused");
  expect(() =>
    assertTransactionCapacity(
      { TransactItems: Array.from({ length: 100 }, (_, n) => check(n)) },
      Array(100).fill(1024),
    ),
  ).not.toThrow();
});

test("fully read Set and nested containers retain their AttributeValue sizing overhead", () => {
  const row = {
    pk: "ENV",
    sk: "SET",
    members: new Set(["a".repeat(1000), "b".repeat(1000)]),
    nested: { empty: {}, list: [{}, [], {}] },
  };
  expect(completeItemSizeBound(row)).toBeGreaterThan(2000);
  expect(
    completeItemSizeBound({
      pk: "ENV",
      sk: "EMPTY",
      nested: { empty: {}, list: [{}, [], {}] },
    }),
  ).toBeGreaterThan(100);
});
