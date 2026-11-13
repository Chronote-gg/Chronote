/** @jest-environment node */
import { GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoJobLeaseRepository } from "../../src/repositories/jobLeaseRepository";
import { jobLeaseContract } from "./jobLeaseRepository.contract";
import {
  createScratchTable,
  describeLocalDynamo,
  localDynamoClient,
} from "./localDynamo.fixture";

describeLocalDynamo("local Dynamo job lease", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  const deploymentControlKeys = {
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" as const },
      { AttributeName: "sk", AttributeType: "S" as const },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" as const },
      { AttributeName: "sk", KeyType: "RANGE" as const },
    ],
  };
  jobLeaseContract(async () => {
    const { TableName, dispose } = await createScratchTable(
      client,
      "job-lease",
      deploymentControlKeys,
    );
    return {
      repository: createDynamoJobLeaseRepository(client, TableName),
      dispose,
    };
  });

  it("an error other than a condition failure is thrown", async () => {
    const repository = createDynamoJobLeaseRepository(client, "missing-table");
    await expect(
      repository.tryAcquireJobLease({
        name: "synthetic-job",
        owner: "owner-a",
        now: 1_000_000,
        ttlSeconds: 600,
      }),
    ).rejects.toThrow();
  });

  it("writes the documented item", async () => {
    const { TableName, dispose } = await createScratchTable(
      client,
      "job-lease",
      deploymentControlKeys,
    );
    try {
      const repository = createDynamoJobLeaseRepository(client, TableName);
      await repository.tryAcquireJobLease({
        name: "synthetic-job",
        owner: "owner-a",
        now: 1_000_000,
        ttlSeconds: 600,
      });
      const stored = await client.send(
        new GetItemCommand({
          TableName,
          Key: marshall({ pk: "JOBS", sk: "JOB#synthetic-job" }),
        }),
      );
      expect(stored.Item && unmarshall(stored.Item)).toEqual({
        pk: "JOBS",
        sk: "JOB#synthetic-job",
        recordType: "job_lease",
        owner: "owner-a",
        expiresAt: 1_000_600,
      });
    } finally {
      await dispose();
    }
  });
});
