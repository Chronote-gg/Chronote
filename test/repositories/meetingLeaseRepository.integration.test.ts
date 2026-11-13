/** @jest-environment node */
import { meetingLeaseRepositoryContract } from "./meetingLeaseRepository.contract";
import { createLeaseTables } from "./meetingLeaseDynamo.fixture";
import {
  describeLocalDynamo,
  localDynamoClient,
} from "./workerRegistryDynamo.fixture";

describeLocalDynamo("local Dynamo meeting lease repository", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  meetingLeaseRepositoryContract(() => createLeaseTables(client));
});
