import { localProtection } from "./fixtures/localProtection";
import { randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  type ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";
import { control, runtime, context } from "./controlFixtures";
import {
  scanProductionWork,
  classifyProductionWork,
  assertProductionDrain,
  metadataDigest,
} from "../../scripts/deployment/production-work.cjs";

const prefix = `carryforward-${randomUUID()}-`;
Object.assign(process.env, {
  NODE_ENV: "development",
  USE_LOCAL_DYNAMODB: "false",
  DDB_TABLE_PREFIX: prefix,
});
const names = {
  webhooks: `${prefix}StripeWebhookEventTable`,
  payments: `${prefix}PaymentTransactionTable`,
  leases: `${prefix}ActiveMeetingTable`,
  history: `${prefix}MeetingHistoryTable`,
  controls: `${prefix}MeetingControlCommandTable`,
  uploads: `${prefix}PersonalMediaUploadJobTable`,
  segments: `${prefix}PersonalRecordingSegmentTable`,
  billing: `${prefix}GuildSubscriptionTable`,
  control: `${prefix}DeploymentControlTable`,
};
const client = new DynamoDBClient({
  endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
});
let repository: ReturnType<
  typeof import("../../src/repositories/personalMediaUploadRepository").getPersonalMediaUploadRepository
>;
let disabledLifecycle: import("../../src/services/runtimeLifecycleService").RuntimeLifecycle;
let processJob: typeof import("../../src/services/personalMediaUploadWorkerService").processPersonalMediaUploadJob;
const binding = {
  accountId: "123456789012",
  region: "us-east-1",
  taskRoleArn: "arn:aws:iam::123456789012:role/synthetic",
  activeMeetingTableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${names.leases}`,
  personalMediaUploadJobTableArn: `arn:aws:dynamodb:us-east-1:123456789012:table/${names.uploads}`,
  operationId: randomUUID(),
  sourceSha: "a".repeat(40),
  legacySha: "b".repeat(40),
  candidateDigest: "sha256:" + "c".repeat(64),
  tableArns: Object.fromEntries(
    Object.entries(names)
      .filter(([key]) => key !== "control")
      .map(([key, name]) => [
        key,
        `arn:aws:dynamodb:us-east-1:123456789012:table/${name}`,
      ]),
  ),
};
const put = (table: string, row: object) =>
  client.send(new PutItemCommand({ TableName: table, Item: marshall(row) }));
const readBytes = async (uploadId: string) =>
  (
    await client.send(
      new GetItemCommand({
        TableName: names.uploads,
        Key: marshall({ uploadId }),
        ConsistentRead: true,
      }),
    )
  ).Item;
beforeAll(async () => {
  for (const [TableName, keyNames] of [
    [names.webhooks, ["eventId"]],
    [names.payments, ["TransactionID"]],
    [names.leases, ["guildId"]],
    [names.history, ["guildId", "channelId_timestamp"]],
    [names.controls, ["requestId"]],
    [names.uploads, ["uploadId"]],
    [names.segments, ["uploadId", "segmentKey"]],
    [names.billing, ["guildId"]],
    [names.control, ["pk", "sk"]],
  ] as const) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keyNames.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index === 0 ? "HASH" : "RANGE",
        })),
        AttributeDefinitions: keyNames.map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
      }),
    );
  }
  repository = (
    await import("../../src/repositories/personalMediaUploadRepository")
  ).getPersonalMediaUploadRepository();
  processJob = (
    await import("../../src/services/personalMediaUploadWorkerService")
  ).processPersonalMediaUploadJob;
  const candidate = runtime("new");
  await put(names.control, {
    ...control,
    servingMembers: { new: candidate.identity },
  });
  await put(names.control, candidate);
  disabledLifecycle = await startDisabledCandidate();
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  disabledLifecycle?.stop();
  for (const TableName of Object.values(names))
    await client.send(new DeleteTableCommand({ TableName }));
  client.destroy();
});
async function startDisabledCandidate() {
  const { createRuntimeLifecycle, installRuntimeLifecycle } =
    await import("../../src/services/runtimeLifecycleService");
  const { createDynamoDeploymentControlRepository } =
    await import("../../src/repositories/deploymentControlRepository");
  const identity = runtime("disabled-candidate", "candidate").identity;
  const protection = localProtection(identity, () => 100, 900);
  const lifecycle = createRuntimeLifecycle({
    identity,
    repository: createDynamoDeploymentControlRepository(client, {
      deploymentControl: names.control,
      meetingHistory: names.history,
      activeMeeting: names.leases,
    }),
    protection,
    now: () => 100,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  installRuntimeLifecycle(lifecycle);
  await lifecycle.start();
  lifecycle.closeAdmission();
  return lifecycle;
}
function legacyJob(
  status: "pending_upload" | "queued" = "queued",
): PersonalMediaUploadJobRecord {
  return {
    uploadId: randomUUID(),
    ownerUserId: "synthetic-owner",
    status,
    mediaKind: "audio",
    sourceS3Key: "synthetic-object",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}
function claim(job: PersonalMediaUploadJobRecord) {
  return {
    uploadId: job.uploadId,
    instanceId: "new",
    nowEpochSeconds: 100,
    claimExpiresAt: 180,
    updatedAt: "2026-01-01T00:01:00Z",
    maxAttempts: 3,
    expectedAttempts: 0,
    claimId: randomUUID(),
    context: {
      ...context,
      instanceId: "new",
      identity: runtime("new").identity,
    },
  };
}
async function snapshot() {
  return scanProductionWork(
    async (service: string, operation: string, input: ScanCommandInput) => {
      if (service !== "dynamodb" || operation !== "scan")
        throw new Error("Unexpected test operation");
      // Local Dynamo accepts table names; retain the exact ARN in the inventory receipt.
      return client.send(
        new ScanCommand({
          ...input,
          TableName: input.TableName?.split("/").at(-1),
        }),
      );
    },
    { binding, observedAt: 100, owners: ["old"], pageSize: 1 },
  );
}
test("a persisted processing webhook alone prevents drain after every other inventory settles", async () => {
  const event = {
    eventId: "evt_local_only",
    state: "processing",
    leaseToken: "synthetic-claim",
    leaseUntil: 90,
    receivedAt: "2026-01-01T00:00:00Z",
    expiresAt: 99,
  };
  await put(names.webhooks, event);
  try {
    const observed = await snapshot();
    expect(
      Object.entries(observed.tables)
        .filter(([name]) => name !== "webhooks")
        .every(([, rows]) => rows.length === 0),
    ).toBe(true);
    const compatibility = { binding, uploads: [] };
    expect(classifyProductionWork(observed, compatibility).counts).toEqual({
      active: 0,
      portable: 0,
      blocked: 1,
      retained: 0,
    });
    expect(() =>
      assertProductionDrain(
        {
          snapshot: observed,
          compatibility,
          now: 102,
          barrier: {
            binding,
            evidenceId: "synthetic-local-barrier",
            admission: "closed",
            effects: "settled",
            owners: ["old"],
            fencedAt: 99,
            checkedAt: 101,
            validUntil: 200,
            revisionBefore: "fixture-observation",
            revisionAfter: "fixture-observation",
          },
        },
        binding,
      ),
    ).toThrow("Uncertain production work");
    const stored = await client.send(
      new GetItemCommand({
        TableName: names.webhooks,
        Key: marshall({ eventId: event.eventId }),
        ConsistentRead: true,
      }),
    );
    expect(stored.Item).toEqual(marshall(event));
  } finally {
    await client.send(
      new DeleteItemCommand({
        TableName: names.webhooks,
        Key: marshall({ eventId: event.eventId }),
      }),
    );
  }
});
test.each(["pending_upload", "queued"] as const)(
  "initialized disabled admission preserves %s legacy bytes",
  async (status) => {
    const { getRuntimeLifecycle } =
      await import("../../src/services/runtimeLifecycleService");
    const { RuntimeAdmissionUnavailable } =
      await import("../../src/services/runtimeAdmissionError");
    const lifecycle = getRuntimeLifecycle();
    expect(lifecycle.getRole()).toBe("candidate");
    expect(lifecycle.isAcceptingWork()).toBe(false);
    const admission = jest.spyOn(lifecycle, "beginRuntimeWork");
    const processingClaim = jest.spyOn(repository, "claim");
    const counts = lifecycle.getWorkCounts();
    const job = legacyJob(status);
    await put(names.uploads, job);
    const before = await readBytes(job.uploadId);
    await processJob(job);
    expect(admission).toHaveBeenCalledTimes(1);
    expect(admission).toHaveBeenCalledWith("pending_admission");
    expect(admission.mock.results[0].type).toBe("throw");
    expect(admission.mock.results[0].value).toBeInstanceOf(
      RuntimeAdmissionUnavailable,
    );
    expect(lifecycle.getWorkCounts()).toEqual(counts);
    expect(processingClaim).not.toHaveBeenCalled();
    expect(await readBytes(job.uploadId)).toEqual(before);
    expect((await repository.get(job.uploadId))?.attempts).toBeUndefined();
  },
);
test.each(["pending_upload", "queued"] as const)(
  "compatible candidate resumes legacy %s exactly once",
  async (status) => {
    const job = legacyJob(status);
    await put(names.uploads, job);
    const before = await readBytes(job.uploadId);
    const observed = await snapshot();
    const projected = observed.tables.uploads.find(
      (row: PersonalMediaUploadJobRecord) => row.uploadId === job.uploadId,
    );
    const compatibility = {
      binding,
      uploads: [
        {
          uploadId: job.uploadId,
          rowDigest: metadataDigest(projected),
          sourceInput: "verified",
          token: "verified",
          schema: "verified",
          ownership: "verified",
          claimProtocol: "verified",
          evidenceId: "synthetic-local-compatibility",
          validUntil: 200,
        },
      ],
    };
    expect(
      classifyProductionWork(observed, compatibility).portable,
    ).toContainEqual({
      table: "uploads",
      key: { uploadId: job.uploadId },
      reason: "portable",
    });
    expect(await readBytes(job.uploadId)).toEqual(before);
    if (status === "pending_upload") {
      expect(await repository.claim(claim(job))).toBeUndefined();
      expect(await readBytes(job.uploadId)).toEqual(before);
      expect(
        await repository.submit(
          { ...job, status: "queued" },
          claim(job).context,
        ),
      ).toBe(true);
      expect(
        await repository.submit(
          { ...job, status: "queued" },
          claim(job).context,
        ),
      ).toBe(false);
    }
    const requests = [claim(job), claim(job)];
    const results = await Promise.all(
      requests.map((request) => repository.claim(request)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.find((result) => result !== undefined);
    expect(winner).toMatchObject({
      uploadId: job.uploadId,
      status: "processing",
      attempts: 1,
      processingOwnerInstanceId: "new",
    });
    const stored = await repository.get(job.uploadId);
    expect(stored).toEqual(winner);
    for (const key of [
      "ownerUserId",
      "sourceS3Key",
      "contentType",
      "fileSize",
      "createdAt",
      "mediaKind",
    ] as const)
      expect(stored?.[key]).toEqual(job[key]);
    expect(
      await repository.claim(requests[results.findIndex(Boolean)]),
    ).toEqual(winner);
    expect(await repository.claim(claim(job))).toBeUndefined();
  },
);
test.each(["expired", "foreign", "unknown"])(
  "inventory blocks %s legacy owners without rewriting them",
  async (kind) => {
    const job: PersonalMediaUploadJobRecord = {
      ...legacyJob(),
      status: "processing",
      ...(kind === "unknown"
        ? {}
        : {
            processingOwnerInstanceId: kind === "foreign" ? "foreign" : "old",
            claimExpiresAt: kind === "expired" ? 90 : 150,
          }),
    };
    await put(names.uploads, job);
    const before = await readBytes(job.uploadId);
    const observed = await snapshot();
    expect(
      classifyProductionWork(observed, { binding, uploads: [] }).blocked,
    ).toContainEqual({
      table: "uploads",
      key: { uploadId: job.uploadId },
      reason: "blocked",
    });
    expect(await readBytes(job.uploadId)).toEqual(before);
  },
);
