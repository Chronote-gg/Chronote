export function meetingUpdateIndexMetadata(manifest) {
  const TableName = manifest.resources.tables.meetingHistory;
  return {
    Table: {
      TableName,
      TableArn: `arn:aws:dynamodb:${manifest.identity.region}:${manifest.identity.accountId}:table/${TableName}`,
      TableStatus: "ACTIVE",
      AttributeDefinitions: [
        { AttributeName: "updateDeliveryQueue", AttributeType: "S" },
        { AttributeName: "updateDeliveryDueAt", AttributeType: "N" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "UpdateDeliveryDueIndex",
          IndexStatus: "ACTIVE",
          KeySchema: [
            { AttributeName: "updateDeliveryQueue", KeyType: "HASH" },
            { AttributeName: "updateDeliveryDueAt", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "KEYS_ONLY" },
        },
      ],
    },
  };
}
