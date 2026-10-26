import {
  DynamoDBClient,
  GetItemCommand,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  controlRecordSchema,
  runtimeRecordSchema,
  sameRuntimeIdentity,
  type ControlRecord,
  type DeploymentControlRecord,
  type RuntimeIdentity,
} from "../types/deploymentControl";

const TRANSACTION_ITEM_LIMIT = 100;
function servingSnapshot(
  raw: unknown,
  writeItems: number,
): ControlRecord | undefined {
  const result = controlRecordSchema.safeParse(raw);
  if (!result.success) return undefined;
  const count = Object.keys(result.data.servingMembers).length;
  return count > 0 && count + 1 + writeItems <= TRANSACTION_ITEM_LIMIT
    ? result.data
    : undefined;
}
function capableRuntime(raw: unknown, identity: RuntimeIdentity): boolean {
  const result = runtimeRecordSchema.safeParse(raw);
  return (
    result.success &&
    result.data.role === "serving" &&
    result.data.canonicalContentWriter === 1 &&
    sameRuntimeIdentity(result.data.identity, identity)
  );
}
function snapshotChecks(
  control: ControlRecord,
  table: string,
): TransactWriteItem[] {
  return [
    {
      ConditionCheck: {
        TableName: table,
        Key: marshall({ pk: "ENV", sk: "CONTROL" }),
        ConditionExpression:
          "protocolVersion = :protocol AND servingGeneration = :generation AND servingMembers = :members",
        ExpressionAttributeValues: marshall({
          ":protocol": control.protocolVersion,
          ":generation": control.servingGeneration,
          ":members": control.servingMembers,
        }),
      },
    },
    ...Object.values(control.servingMembers).map((identity) => ({
      ConditionCheck: {
        TableName: table,
        Key: marshall({ pk: "ENV", sk: "RUNTIME#" + identity.instanceId }),
        ConditionExpression:
          "#identity = :identity AND #role = :serving AND canonicalContentWriter = :capability",
        ExpressionAttributeNames: { "#identity": "identity", "#role": "role" },
        ExpressionAttributeValues: marshall({
          ":identity": identity,
          ":serving": "serving",
          ":capability": 1,
        }),
      },
    })),
  ];
}
// Capability is advertised by the actual runtime, never inferred from protocol1 or labels.
// Fence the roster as well as each capability: retained old peers may still acquire work.
export async function readCanonicalWriterChecks(
  client: DynamoDBClient,
  table: string,
  writeItems: number,
  signal?: AbortSignal,
): Promise<TransactWriteItem[] | undefined> {
  const read = async (sk: string) => {
    const result = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall({ pk: "ENV", sk }),
        ConsistentRead: true,
      }),
      { abortSignal: signal },
    );
    return result.Item ? unmarshall(result.Item) : undefined;
  };
  const control = servingSnapshot(await read("CONTROL"), writeItems);
  if (!control) return undefined;
  const identities = Object.values(control.servingMembers);
  const runtimes = await Promise.all(
    identities.map((identity) => read("RUNTIME#" + identity.instanceId)),
  );
  if (
    !identities.every((identity, index) =>
      capableRuntime(runtimes[index], identity),
    )
  )
    return undefined;
  return snapshotChecks(control, table);
}
export function mockCanonicalWritersAllowEdit(
  records: ReadonlyMap<string, DeploymentControlRecord>,
  writeItems: number,
): boolean {
  const read = (sk: string) => records.get(JSON.stringify(["ENV", sk]));
  const control = servingSnapshot(read("CONTROL"), writeItems);
  return Boolean(
    control &&
    Object.values(control.servingMembers).every((identity) =>
      capableRuntime(read("RUNTIME#" + identity.instanceId), identity),
    ),
  );
}
