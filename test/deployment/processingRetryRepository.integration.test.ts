import { createDynamoProcessingRetryRepository } from "../../src/repositories/processingRetryRepository";
import type { MeetingHistory } from "../../src/types/db";
import {
  PROCESSING_RETRY_QUEUE,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";
import type { MeetingUpdateKey } from "../../src/types/meetingUpdateDelivery";
import { authority } from "../repositories/meetingUpdateDeliveryContract";
import {
  expectedOf,
  failedJob,
  failedRow,
  queuedJob,
  queuedRow,
} from "../repositories/processingRetryRepository.fixture";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import { meetingUpdateDynamoFixture } from "./meetingUpdateDynamo.fixture";

const { tables, client, put, createTables, read, admit, dispose } =
  meetingUpdateDynamoFixture("processing-retry");
const repository = createDynamoProcessingRetryRepository(client, tables);

const claimA = {
  ownerInstanceId: "instance-a",
  claimId: "claim-a",
  leaseExpiresAt: now + 300,
};
const runningJob: ProcessingRetryJob = {
  ...queuedJob,
  status: "running",
  claim: claimA,
};
const runningRow = (claim = claimA) =>
  queuedRow({
    processingRetry: { ...runningJob, claim },
    processingRetryDueAt: claim.leaseExpiresAt,
  });

const seed = (row: MeetingHistory) => put(tables.meetingHistory, row);
const claim = (claimId: string) =>
  repository.claim({
    key,
    jobId: queuedJob.jobId,
    claimId,
    ownerInstanceId: "instance-b",
    now,
    leaseExpiresAt: now + 300,
    authority,
  });

beforeAll(createTables);
beforeEach(() => admit(true));
afterAll(dispose);

it.each([
  ["queued", queuedRow()],
  ["running", runningRow()],
])("queue refuses while a %s job is active", async (_status, row) => {
  await seed(row);
  const next = { ...queuedJob, jobId: "job-2" };
  expect(
    await repository.queue({
      key,
      expected: expectedOf(row),
      job: next,
      dueAt: now,
    }),
  ).toBe("conflict");
  expect(await read()).toEqual(row);
});

it("queue replaces a terminal job it was shown", async () => {
  const row = { ...failedRow(), processingRetry: failedJob(runningJob) };
  await seed(row);
  const next = { ...queuedJob, jobId: "job-2" };
  expect(
    await repository.queue({
      key,
      expected: expectedOf(row),
      job: next,
      dueAt: now,
    }),
  ).toBe("queued");
  expect(await read()).toMatchObject({
    processingRetry: next,
    processingRetryQueue: PROCESSING_RETRY_QUEUE,
    processingRetryDueAt: now,
  });
});

it.each([
  ["a queued job", queuedRow()],
  [
    "a running job whose lease expired",
    runningRow({ ...claimA, leaseExpiresAt: now - 1 }),
  ],
])("claim takes %s under the worker's claimId", async (_case, row) => {
  await seed(row);
  const claimed = await claim("claim-b");
  const expectedClaim = {
    ownerInstanceId: "instance-b",
    claimId: "claim-b",
    leaseExpiresAt: now + 300,
  };
  expect(claimed).toMatchObject({ status: "running", claim: expectedClaim });
  expect(await read()).toMatchObject({
    processingRetry: { status: "running", claim: expectedClaim },
    processingRetryDueAt: now + 300,
  });
});

it("claim refuses a live lease and a fenced runtime", async () => {
  await seed(runningRow());
  expect(await claim("claim-b")).toBeUndefined();
  await seed(queuedRow());
  await admit(false);
  expect(await claim("claim-b")).toBeUndefined();
  expect(await read()).toEqual(queuedRow());
});

it("renew requires the matching claimId", async () => {
  await seed(runningRow());
  const renew = (claimId: string) =>
    repository.renew({
      key,
      jobId: queuedJob.jobId,
      ownerInstanceId: claimA.ownerInstanceId,
      claimId,
      leaseExpiresAt: now + 600,
    });
  expect(await renew("claim-other")).toBe(false);
  expect((await read())?.processingRetryDueAt).toBe(claimA.leaseExpiresAt);
  expect(await renew(claimA.claimId)).toBe(true);
  expect(await read()).toMatchObject({
    processingRetry: { claim: { ...claimA, leaseExpiresAt: now + 600 } },
    processingRetryDueAt: now + 600,
  });
});

it("fail requires the matching claimId and leaves the due index", async () => {
  await seed(runningRow());
  const failed = failedJob(runningJob);
  expect(
    await repository.fail({
      key,
      expected: { ...runningJob, claim: { ...claimA, claimId: "claim-other" } },
      failed,
    }),
  ).toBe("stale");
  expect(await read()).toEqual(runningRow());
  expect(await repository.fail({ key, expected: runningJob, failed })).toBe(
    "applied",
  );
  const after = await read();
  expect(after?.processingRetry).toEqual(failed);
  expect(after).not.toHaveProperty("processingRetryQueue");
  expect(after).not.toHaveProperty("processingRetryDueAt");
  expect(await repository.listDue({ now: now + 10_000, limit: 25 })).toEqual(
    [],
  );
});

it("listDue reads only due rows from ProcessingRetryDueIndex in due order", async () => {
  const at = (suffix: string): MeetingUpdateKey => ({
    ...key,
    channelId_timestamp: `${key.channelId_timestamp}#${suffix}`,
  });
  const rows = [
    { ...queuedRow({ processingRetryDueAt: now }), ...at("second") },
    { ...queuedRow({ processingRetryDueAt: now - 10 }), ...at("first") },
    { ...queuedRow({ processingRetryDueAt: now + 60 }), ...at("future") },
    { ...failedRow(), ...at("not-queued") },
  ];
  await seed(failedRow());
  for (const row of rows) await seed(row);
  expect(await repository.listDue({ now, limit: 25 })).toEqual([
    at("first"),
    at("second"),
  ]);
  expect(await repository.listDue({ now, limit: 1 })).toEqual([at("first")]);
});
