const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTableCommand,
} = require("@aws-sdk/client-dynamodb");

require("dotenv").config();

const client = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "local",
  credentials: {
    accessKeyId: "dummy",
    secretAccessKey: "dummy",
  },
});

const tablePrefix = process.env.DDB_TABLE_PREFIX || "";
const tableName = (name) => `${tablePrefix}${name}`;
const feedbackIndexName = "TargetTypeCreatedAtIndex";
const feedbackIndexDefinition = {
  IndexName: feedbackIndexName,
  KeySchema: [
    { AttributeName: "targetType", KeyType: "HASH" },
    { AttributeName: "createdAt", KeyType: "RANGE" },
  ],
  Projection: { ProjectionType: "ALL" },
};

const tables = [
  {
    TableName: "PaymentTransactionTable",
    KeySchema: [{ AttributeName: "TransactionID", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "TransactionID", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "StripeWebhookEventTable",
    KeySchema: [{ AttributeName: "eventId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "eventId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "InteractionReceiptTable",
    KeySchema: [{ AttributeName: "interactionId", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "interactionId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "ActiveMeetingTable",
    KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "guildId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "AccessLogsTable",
    KeySchema: [{ AttributeName: "AccessLogID", KeyType: "HASH" }],
    AttributeDefinitions: [
      { AttributeName: "AccessLogID", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "RecordingTranscriptTable",
    KeySchema: [{ AttributeName: "MeetingID", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "MeetingID", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "AutoRecordSettingsTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "channelId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "channelId", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GuildRecordAllIndex",
        KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "SessionTable",
    KeySchema: [{ AttributeName: "sid", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "sid", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "ServerContextTable",
    KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "guildId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "ChannelContextTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "channelId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "channelId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "DictionaryTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "termKey", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "termKey", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "UserSpeechSettingsTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "userId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "ConfigOverridesTable",
    KeySchema: [
      { AttributeName: "scopeId", KeyType: "HASH" },
      { AttributeName: "configKey", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "scopeId", AttributeType: "S" },
      { AttributeName: "configKey", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "MeetingHistoryTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "channelId_timestamp", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "channelId_timestamp", AttributeType: "S" },
      { AttributeName: "timestamp", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GuildTimestampIndex",
        KeySchema: [
          { AttributeName: "guildId", KeyType: "HASH" },
          { AttributeName: "timestamp", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "MeetingShareTable",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "GuildSubscriptionTable",
    KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "guildId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "InstallerTable",
    KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
    AttributeDefinitions: [{ AttributeName: "guildId", AttributeType: "S" }],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "OnboardingStateTable",
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "userId", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "AskConversationTable",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
  {
    TableName: "FeedbackTable",
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "targetType", AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "TargetTypeCreatedAtIndex",
        KeySchema: [
          { AttributeName: "targetType", KeyType: "HASH" },
          { AttributeName: "createdAt", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  },
];

async function waitForDynamoDB(maxRetries = 10, delay = 1000) {
  const { ListTablesCommand } = require("@aws-sdk/client-dynamodb");

  for (let i = 0; i < maxRetries; i++) {
    try {
      await client.send(new ListTablesCommand({}));
      console.log("✅ Connected to DynamoDB Local");
      return true;
    } catch {
      if (i === maxRetries - 1) {
        throw new Error(
          "Could not connect to DynamoDB Local. Is Docker running?",
        );
      }
      console.log(
        `⏳ Waiting for DynamoDB Local to be ready... (attempt ${i + 1}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return false;
}

async function createTables() {
  console.log("Initializing DynamoDB tables...");
  console.log("Connecting to DynamoDB at http://localhost:8000");

  try {
    await waitForDynamoDB();
  } catch (error) {
    console.error("\n❌ " + error.message);
    console.error("\nPlease make sure DynamoDB Local is running:");
    console.error("  yarn docker:up");
    console.error("\nOr use the combined command:");
    console.error("  yarn dev");
    process.exit(1);
  }

  let ensureFeedbackIndex = false;

  for (const table of tables) {
    const tableWithPrefix = {
      ...table,
      TableName: tableName(table.TableName),
    };
    try {
      await client.send(new CreateTableCommand(tableWithPrefix));
      console.log(`✅ Created table: ${tableWithPrefix.TableName}`);
    } catch (error) {
      if (error.name === "ResourceInUseException") {
        console.log(`⚠️  Table ${tableWithPrefix.TableName} already exists`);
        if (table.TableName === "FeedbackTable") {
          ensureFeedbackIndex = true;
        }
      } else {
        console.error(
          `❌ Error creating table ${tableWithPrefix.TableName}:`,
          error.message,
        );
      }
    }
  }

  if (ensureFeedbackIndex) {
    await ensureFeedbackIndexExists();
  }

  console.log("\nDynamoDB initialization complete!");
  console.log("You can view your tables at http://localhost:8001");
}

async function ensureFeedbackIndexExists() {
  const feedbackTableName = tableName("FeedbackTable");

  try {
    const result = await client.send(
      new DescribeTableCommand({ TableName: feedbackTableName }),
    );
    const existingIndexes = result.Table?.GlobalSecondaryIndexes ?? [];
    const hasIndex = existingIndexes.some(
      (index) => index.IndexName === feedbackIndexName,
    );
    if (hasIndex) {
      console.log(
        `FeedbackTable already has ${feedbackIndexName} on ${feedbackTableName}`,
      );
      return;
    }
  } catch (error) {
    if (error.name === "ResourceNotFoundException") {
      return;
    }
    console.error(
      `Error describing table ${feedbackTableName}:`,
      error.message,
    );
    return;
  }

  try {
    await client.send(
      new UpdateTableCommand({
        TableName: feedbackTableName,
        AttributeDefinitions: [
          { AttributeName: "targetType", AttributeType: "S" },
          { AttributeName: "createdAt", AttributeType: "S" },
        ],
        GlobalSecondaryIndexUpdates: [
          {
            Create: feedbackIndexDefinition,
          },
        ],
      }),
    );
    console.log(`Added ${feedbackIndexName} to ${feedbackTableName}`);
  } catch (error) {
    console.error(
      `Error adding ${feedbackIndexName} to ${feedbackTableName}:`,
      error.message,
    );
    console.error(
      "If you are using DynamoDB Local, you may need to reset your local database and rerun this init script.",
    );
    console.error(
      "For example, if you run DynamoDB Local with docker-compose you can do:",
    );
    console.error("  docker-compose down -v");
    console.error("  docker-compose up -d");
    console.error(
      "After resetting DynamoDB Local, rerun the initialization to recreate the FeedbackTable and its indexes.",
    );
  }
}

createTables().catch((error) => {
  console.error("Failed to initialize DynamoDB:", error);
  process.exit(1);
});
