import { marshall } from "@aws-sdk/util-dynamodb";
export function dynamoSnapshotCondition(
  record: object,
  fields: readonly string[],
) {
  const entries = Object.entries(record);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const clauses = fields.map((field, i) => {
    const key = `#o${i}`;
    names[key] = field;
    const value = entries.find(([name]) => name === field)?.[1];
    if (value === undefined) return `attribute_not_exists(${key})`;
    values[`:o${i}`] = value;
    return `${key} = :o${i}`;
  });
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? {
          ExpressionAttributeValues: marshall(values, {
            removeUndefinedValues: true,
          }),
        }
      : {}),
  };
}
