import { Buffer } from "node:buffer";
import { marshall } from "@aws-sdk/util-dynamodb";
import type {
  TransactWriteItem,
  TransactWriteItemsCommandInput,
} from "@aws-sdk/client-dynamodb";

export function snapshotCondition(
  table: string,
  key: Record<string, unknown>,
  row: Record<string, unknown>,
  fields: readonly string[],
  presentFields: readonly string[] = [],
): NonNullable<TransactWriteItem["ConditionCheck"]> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const conditions = fields.map((field, index) => {
    const parts = field.split(".");
    let value: unknown = row;
    const path = parts
      .map((part, partIndex) => {
        const alias =
          parts.length === 1 ? `#f${index}` : `#f${index}_${partIndex}`;
        names[alias] = part;
        value =
          value && typeof value === "object"
            ? Reflect.get(value, part)
            : undefined;
        return alias;
      })
      .join(".");
    if (presentFields.includes(field)) return `attribute_exists(${path})`;
    if (value === undefined) return `attribute_not_exists(${path})`;
    values[`:v${index}`] = value;
    return `${path} = :v${index}`;
  });
  if (!fields.length) throw new Error("acceptance_condition_refused");
  return {
    TableName: table,
    Key: marshall(key),
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? { ExpressionAttributeValues: marshall(values) }
      : {}),
  };
}

/** Wire JSON plus overhead bounds a fully read item; projections must use the 400 KB ceiling. */
export function completeItemSizeBound(row: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(marshall(row)), "utf8") + 100;
}

export type CapacityBound = {
  table: string;
  key: Record<string, unknown>;
  maximumItemBytes: number;
};
export function assertCapacityBounds(bounds: readonly CapacityBound[]): void {
  if (!bounds.length || bounds.length > 100)
    throw new Error("acceptance_capacity_refused");
  const targets = new Set<string>();
  let total = 0;
  for (const { table, key, maximumItemBytes: bytes } of bounds) {
    const target = JSON.stringify([
      table,
      Object.entries(key).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    if (
      targets.has(target) ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0 ||
      bytes > 400 * 1024
    )
      throw new Error("acceptance_capacity_refused");
    targets.add(target);
    total += bytes;
  }
  if (total > 4 * 1024 * 1024) throw new Error("acceptance_capacity_refused");
}
export function assertTransactionCapacity(
  input: TransactWriteItemsCommandInput,
  maximumItemBytes?: readonly number[],
): void {
  const items = input.TransactItems;
  if (!items || (maximumItemBytes && maximumItemBytes.length !== items.length))
    throw new Error("acceptance_capacity_refused");
  assertCapacityBounds(
    items.map((item, index) => {
      if (item.Delete) throw new Error("acceptance_capacity_refused");
      if (item.Put) {
        const { TableName: table, Item: row } = item.Put;
        if (!table || !row?.pk || !row.sk)
          throw new Error("acceptance_capacity_refused");
        return {
          table,
          key: { pk: row.pk, sk: row.sk },
          maximumItemBytes: Math.max(
            Buffer.byteLength(JSON.stringify(row), "utf8") + 100,
            maximumItemBytes?.[index] ?? 0,
          ),
        };
      }
      const operation = item.Update ?? item.ConditionCheck;
      if (!operation?.TableName || !operation.Key)
        throw new Error("acceptance_capacity_refused");
      return {
        table: operation.TableName,
        key: operation.Key,
        maximumItemBytes: maximumItemBytes?.[index] ?? 400 * 1024,
      };
    }),
  );
}
