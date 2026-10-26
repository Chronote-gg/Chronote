import vm from "node:vm";
import ts from "typescript";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from "@aws-sdk/client-dynamodb";
import legacy from "./legacy593a.json";
export function loadLegacyDatabase(dynamoDbClient, tableName) {
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(legacy.functions.join("\n"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    {
      exports,
      dynamoDbClient,
      tableName,
      marshall,
      unmarshall,
      PutItemCommand,
      UpdateItemCommand,
      DeleteItemCommand,
      isConditionalCheckFailed: (error) =>
        error.name === "ConditionalCheckFailedException",
    },
  );
  return exports;
}
