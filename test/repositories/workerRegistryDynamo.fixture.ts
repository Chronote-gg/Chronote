import { type DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  createDynamoWorkerRegistryRepository,
  type LegacyRow,
  type WorkerRegistryRepository,
} from "../../src/repositories/workerRegistryRepository";
import { createScratchTable } from "./localDynamo.fixture";
import { deploymentControlKeySchema } from "../fixtures/deploymentControlKeySchema";

export { describeLocalDynamo, localDynamoClient } from "./localDynamo.fixture";

/** A throwaway table with the DeploymentControlTable key schema. */
export async function createRegistryTable(client: DynamoDBClient): Promise<{
  repository: WorkerRegistryRepository;
  seedLegacy(row: LegacyRow): Promise<void>;
  dispose(): Promise<void>;
}> {
  const { TableName, dispose } = await createScratchTable(
    client,
    "worker-registry",
    deploymentControlKeySchema,
  );
  return {
    repository: createDynamoWorkerRegistryRepository(client, TableName),
    async seedLegacy(row) {
      await client.send(new PutItemCommand({ TableName, Item: marshall(row) }));
    },
    dispose,
  };
}
