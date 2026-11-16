import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as dynamo from "@aws-sdk/client-dynamodb";

function runInitializationScript(
  DynamoDBClient: new () => object,
  env: Record<string, string>,
): Promise<void> {
  const source = readFileSync("scripts/init-dynamodb.js", "utf8");
  const end = source.lastIndexOf("createTables().catch");
  if (end < 0) throw Error("Initialization entrypoint missing");
  return runInNewContext(source.slice(0, end) + "createTables();", {
    require: (name: string) =>
      name === "dotenv" ? { config() {} } : { ...dynamo, DynamoDBClient },
    console: { log() {}, error() {} },
    process: { env },
    setTimeout,
  });
}

export function runDynamoInitialization(
  send: (command: object) => Promise<unknown>,
): Promise<void> {
  return runInitializationScript(
    class {
      send = send;
    },
    {},
  );
}

/** Runs the real init script against a real endpoint, under the given table prefix. */
export function runDynamoInitializationAgainst(
  clientConfig: dynamo.DynamoDBClientConfig,
  tablePrefix: string,
): Promise<void> {
  return runInitializationScript(
    class extends dynamo.DynamoDBClient {
      constructor() {
        super(clientConfig);
      }
    },
    { DDB_TABLE_PREFIX: tablePrefix },
  );
}
