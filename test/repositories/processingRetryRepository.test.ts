/** @jest-environment node */
import { randomUUID } from "node:crypto";
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  createDynamoProcessingRetryRepository,
  createMockProcessingRetryRepository,
} from "../../src/repositories/processingRetryRepository";
import type { MeetingHistory } from "../../src/types/db";
import {
  PROCESSING_RETRY_QUEUE,
  type ProcessingRetryJob,
} from "../../src/types/meetingProcessingRetry";
import type { MeetingUpdateKey } from "../../src/types/meetingUpdateDelivery";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import {
  expectedOf,
  failedJob,
  failedNotes,
  failedRow,
  queuedJob,
  queuedRow,
} from "./processingRetryRepository.fixture";

let histories: Map<string, MeetingHistory[]>;
const repository = () => createMockProcessingRetryRepository(histories);
function seed(...rows: MeetingHistory[]) {
  for (const row of rows)
    histories.set(row.guildId, [
      ...(histories.get(row.guildId) ?? []),
      structuredClone(row),
    ]);
}
const read = (at: MeetingUpdateKey = key) =>
  structuredClone(
    histories
      .get(at.guildId)
      ?.find((row) => row.channelId_timestamp === at.channelId_timestamp),
  );
const claim = (at: number, ownerInstanceId = "instance-a", jobId = "job-1") =>
  repository().claim({
    key,
    jobId,
    claimId: randomUUID(),
    ownerInstanceId,
    now: at,
    leaseExpiresAt: at + 300,
  });

beforeEach(() => {
  histories = new Map();
});

describe("queue", () => {
  it("queues only when processing, notes version and the previous terminal job match", async () => {
    const row = failedRow();
    seed(row);
    const queue = (expected: ReturnType<typeof expectedOf>) =>
      repository().queue({ key, expected, job: queuedJob, dueAt: now });
    const mismatches = [
      {
        ...expectedOf(row),
        processing: { ...failedNotes, summary: "failed" as const },
      },
      { ...expectedOf(row), notesVersion: 2 },
      { ...expectedOf(row), processingRetry: queuedJob },
    ];
    for (const expected of mismatches)
      expect(await queue(expected)).toBe("conflict");
    expect(read()).toEqual(row);
    expect(await queue({ ...expectedOf(row), notesVersion: 1 })).toBe("queued");
    expect(read()).toEqual({
      ...row,
      processingRetry: queuedJob,
      processingRetryQueue: PROCESSING_RETRY_QUEUE,
      processingRetryDueAt: now,
    });
  });

  it("queues over a terminal job it was shown, never over an active one", async () => {
    const terminal = { ...queuedJob, status: "failed" as const };
    const row = { ...failedRow(), processingRetry: terminal };
    seed(row);
    const next = { ...queuedJob, jobId: "job-2" };
    expect(
      await repository().queue({
        key,
        expected: expectedOf(row),
        job: next,
        dueAt: now,
      }),
    ).toBe("queued");
    expect(read()?.processingRetry).toEqual(next);
    expect(
      await repository().queue({
        key,
        expected: expectedOf(read()!),
        job: { ...queuedJob, jobId: "job-3" },
        dueAt: now,
      }),
    ).toBe("conflict");
  });

  it("a second queue for the same meeting conflicts", async () => {
    const row = failedRow();
    seed(row);
    const results = await Promise.all(
      ["job-1", "job-2"].map((jobId) =>
        repository().queue({
          key,
          expected: expectedOf(row),
          job: { ...queuedJob, jobId },
          dueAt: now,
        }),
      ),
    );
    expect(results.sort()).toEqual(["conflict", "queued"]);
  });

  it("conflicts for a missing meeting", async () => {
    expect(
      await repository().queue({
        key,
        expected: expectedOf(failedRow()),
        job: queuedJob,
        dueAt: now,
      }),
    ).toBe("conflict");
  });
});

describe("claim", () => {
  it("claim admits a queued job and a running job whose lease lapsed, never a live lease", async () => {
    seed(queuedRow());
    const first = await claim(now);
    expect(first).toMatchObject({
      status: "running",
      claim: { ownerInstanceId: "instance-a", leaseExpiresAt: now + 300 },
    });
    expect(read()).toMatchObject({
      processingRetry: first,
      processingRetryQueue: PROCESSING_RETRY_QUEUE,
      processingRetryDueAt: now + 300,
    });
    expect(await claim(now + 299, "instance-b")).toBeUndefined();
    expect(await claim(now + 300, "instance-b", "job-2")).toBeUndefined();
    const second = await claim(now + 300, "instance-b");
    expect(second?.claim).toMatchObject({
      ownerInstanceId: "instance-b",
      leaseExpiresAt: now + 600,
    });
    expect(second?.claim?.claimId).not.toBe(first?.claim?.claimId);
    expect(read()?.processingRetry).toEqual(second);
  });

  it("a lapsed lease re-claimed by the same instance gets a fresh claim id", async () => {
    seed(queuedRow());
    const first = await claim(now);
    const second = await claim(now + 300);
    expect(second?.claim?.ownerInstanceId).toBe("instance-a");
    expect(second?.claim?.claimId).not.toBe(first?.claim?.claimId);
  });

  it.each(["succeeded", "failed"] as const)(
    "never claims a %s job",
    async (status) => {
      seed(queuedRow({ processingRetry: { ...queuedJob, status } }));
      expect(await claim(now)).toBeUndefined();
    },
  );

  it("two workers claiming the same job at once: exactly one claim lands", async () => {
    seed(queuedRow());
    const results = await Promise.all([
      claim(now, "instance-a"),
      claim(now, "instance-b"),
    ]);
    const won = results.filter((job) => job !== undefined);
    expect(won).toHaveLength(1);
    expect(read()?.processingRetry?.claim).toEqual(won[0]?.claim);
  });
});

describe("renew and fail", () => {
  it("renew and fail require the same job and owner", async () => {
    seed(queuedRow());
    const running = (await claim(now))!;
    const claimId = running.claim!.claimId;
    const renew = (patch: object) =>
      repository().renew({
        key,
        jobId: "job-1",
        ownerInstanceId: "instance-a",
        claimId,
        leaseExpiresAt: now + 600,
        ...patch,
      });
    expect(await renew({ jobId: "job-2" })).toBe(false);
    expect(await renew({ ownerInstanceId: "instance-b" })).toBe(false);
    expect(await renew({ claimId: "other-claim" })).toBe(false);
    expect(read()?.processingRetryDueAt).toBe(now + 300);
    expect(await renew({})).toBe(true);
    expect(read()).toMatchObject({
      processingRetry: { claim: { claimId, leaseExpiresAt: now + 600 } },
      processingRetryDueAt: now + 600,
    });

    const failed = failedJob(running);
    const fail = (expected: ProcessingRetryJob) =>
      repository().fail({
        key,
        expected,
        failed: { ...failed, jobId: expected.jobId },
      });
    expect(await fail({ ...running, jobId: "job-2" })).toBe("stale");
    expect(
      await fail({
        ...running,
        claim: { ...running.claim!, ownerInstanceId: "instance-b" },
      }),
    ).toBe("stale");
    expect(
      await fail({ ...running, claim: { ...running.claim!, claimId: "x" } }),
    ).toBe("stale");
    expect(await fail(running)).toBe("applied");
  });

  it("fail never overwrites a job that already left running", async () => {
    seed(queuedRow());
    const running = (await claim(now))!;
    const succeeded = queuedRow({
      processingRetry: { ...running, status: "succeeded", claim: undefined },
      processingRetryQueue: undefined,
      processingRetryDueAt: undefined,
    });
    histories.set(key.guildId, [structuredClone(succeeded)]);
    expect(
      await repository().fail({
        key,
        expected: running,
        failed: failedJob(running),
      }),
    ).toBe("stale");
    expect(read()).toEqual(succeeded);
  });

  it("fail removes the queue keys and leaves content untouched", async () => {
    seed(queuedRow({ notes: "Kept notes", notesVersion: 2 }));
    const running = (await claim(now))!;
    const before = read()!;
    const failed = failedJob(running);
    expect(await repository().fail({ key, expected: running, failed })).toBe(
      "applied",
    );
    const after = read()!;
    expect(after.processingRetry).toEqual(failed);
    expect(after).not.toHaveProperty("processingRetryQueue");
    expect(after).not.toHaveProperty("processingRetryDueAt");
    for (const field of [
      "notes",
      "notesVersion",
      "processing",
      "contentRevision",
    ] as const)
      expect(after[field]).toEqual(before[field]);
  });
});

const other = (suffix: string, patch: Partial<MeetingHistory>) => ({
  ...queuedRow(),
  channelId_timestamp: `999999999999999991#${suffix}`,
  ...patch,
});

it("listDue returns every due key regardless of status", async () => {
  const lapsed = other("lapsed", {
    processingRetry: {
      ...queuedJob,
      status: "running",
      claim: {
        ownerInstanceId: "instance-b",
        claimId: "claim-b",
        leaseExpiresAt: now - 10,
      },
    },
    processingRetryDueAt: now - 10,
  });
  seed(
    queuedRow(),
    lapsed,
    other("later", { processingRetryDueAt: now + 1 }),
    other("idle", {
      processingRetryQueue: undefined,
      processingRetryDueAt: undefined,
    }),
  );
  const due = (limit: number) => repository().listDue({ now, limit });
  const lapsedKey = {
    guildId: key.guildId,
    channelId_timestamp: lapsed.channelId_timestamp,
  };
  expect(await due(10)).toEqual([lapsedKey, key]);
  expect(await due(1)).toEqual([lapsedKey]);
});

it("scan filters by window and guild", async () => {
  const at = (suffix: string, timestamp: string, guildId = key.guildId) => ({
    ...failedRow(),
    guildId,
    channelId_timestamp: `999999999999999991#${suffix}`,
    timestamp,
  });
  const inside = at("inside", "2026-10-22T12:00:00.000Z");
  const otherGuild = at(
    "guild",
    "2026-10-22T13:00:00.000Z",
    "999999999999999980",
  );
  seed(
    inside,
    otherGuild,
    at("before", "2026-10-21T23:59:59.000Z"),
    at("after", "2026-10-23T00:00:01.000Z"),
    { ...at("legacy", "2026-10-22T14:00:00.000Z"), processing: undefined },
  );
  const window = {
    from: "2026-10-22T00:00:00.000Z",
    to: "2026-10-23T00:00:00.000Z",
  };
  const ids = async (guildId?: string) =>
    (await repository().scan({ ...window, guildId })).rows
      .map((row) => row.channelId_timestamp)
      .sort();
  expect(await ids()).toEqual(
    [inside, otherGuild].map((row) => row.channelId_timestamp).sort(),
  );
  expect(await ids(key.guildId)).toEqual([inside.channelId_timestamp]);
});

describe("a refused write whose read-back fails", () => {
  /** Reads the row, refuses the write, then fails the read-back. */
  function failingReadBack(row: MeetingHistory) {
    const client = new DynamoDBClient({ region: "local" });
    let reads = 0;
    jest.spyOn(client, "send").mockImplementation(async (command) => {
      if (command instanceof UpdateItemCommand)
        throw Object.assign(new Error("condition failed"), {
          name: "ConditionalCheckFailedException",
        });
      if (++reads > 1) throw new Error("read unavailable");
      return { Item: marshall(row, { removeUndefinedValues: true }) };
    });
    return createDynamoProcessingRetryRepository(client, {
      meetingHistory: "synthetic-history",
      deploymentControl: "synthetic-control",
    });
  }
  afterEach(() => jest.restoreAllMocks());

  it("claim treats it as lost and warns instead of throwing", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const repository = failingReadBack(queuedRow());
    await expect(
      repository.claim({
        key,
        jobId: "job-1",
        claimId: "claim-a",
        ownerInstanceId: "instance-a",
        now,
        leaseExpiresAt: now + 300,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("queue reports a conflict instead of throwing", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const row = failedRow();
    const repository = failingReadBack(row);
    await expect(
      repository.queue({
        key,
        expected: expectedOf(row),
        job: queuedJob,
        dueAt: now,
      }),
    ).resolves.toBe("conflict");
  });
});
