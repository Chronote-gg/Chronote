/** @jest-environment node */
import { workerRegistryContract } from "./workerRegistryRepository.contract";
import {
  createRegistryTable,
  describeLocalDynamo,
  localDynamoClient,
} from "./workerRegistryDynamo.fixture";

describeLocalDynamo("local Dynamo worker registry", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  workerRegistryContract(() => createRegistryTable(client));
});
