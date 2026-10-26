import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as dynamo from "@aws-sdk/client-dynamodb";
export function runDynamoInitialization(
  send: (command: object) => Promise<unknown>,
): Promise<void> {
  const source = readFileSync("scripts/init-dynamodb.js", "utf8");
  const end = source.lastIndexOf("createTables().catch");
  if (end < 0) throw Error("Initialization entrypoint missing");
  return runInNewContext(source.slice(0, end) + "createTables();", {
    require: (name: string) =>
      name === "dotenv"
        ? { config() {} }
        : {
            ...dynamo,
            DynamoDBClient: class {
              send = send;
            },
          },
    console: { log() {}, error() {} },
    process: { env: {} },
    setTimeout,
  });
}
