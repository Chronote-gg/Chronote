/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
const mockSend = jest.fn();
jest.mock("@aws-sdk/client-dynamodb", () => ({
  ...jest.requireActual("@aws-sdk/client-dynamodb"),
  DynamoDBClient: jest.fn(() => ({ send: mockSend })),
}));
import { TransactionCanceledException } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
  claimPersonalMediaUploadJob,
  listClaimablePersonalMediaUploadJobs,
  submitPersonalMediaUploadJob,
} from "../../src/db";
import { config } from "../../src/services/configService";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";
import { context } from "../deployment/controlFixtures";
const job: PersonalMediaUploadJobRecord = {
  uploadId: "synthetic",
  ownerUserId: "owner",
  status: "processing",
  processingClaimId: "claim",
  processingOwnerInstanceId: "old",
  attempts: 1,
  claimExpiresAt: 200,
  mediaKind: "audio",
  sourceS3Key: "source",
  contentType: "audio/wav",
  fileSize: 10,
  createdAt: "now",
  updatedAt: "now",
};
beforeEach(() => {
  config.mock.enabled = false;
  mockSend.mockReset();
});
afterAll(() => {
  config.mock.enabled = true;
});
test("same-claim shortcut refuses a malformed pause record", async () => {
  mockSend
    .mockResolvedValueOnce({ Item: marshall(job) })
    .mockResolvedValueOnce({
      Item: marshall({
        pk: "UPLOAD#synthetic",
        sk: "PAUSED_DRAFT",
        recordType: "foreign",
      }),
    });
  await expect(
    claimPersonalMediaUploadJob({
      uploadId: job.uploadId,
      instanceId: "old",
      nowEpochSeconds: 100,
      claimExpiresAt: 200,
      updatedAt: "now",
      maxAttempts: 3,
      context,
      claimId: "claim",
      expectedAttempts: 1,
    }),
  ).rejects.toThrow();
});
test.each(["paused", "owner mismatch", "read unavailable", "unpaused"])(
  "same-claim shortcut: %s",
  async (scenario) => {
    const marker = buildPausedDesktopDraftMarker(job, {
      ownerUserId: scenario === "owner mismatch" ? "other" : job.ownerUserId,
      operationId: "operation",
    });
    mockSend.mockResolvedValueOnce({ Item: marshall(job) });
    if (scenario === "read unavailable")
      mockSend.mockRejectedValueOnce(new Error("read unavailable"));
    else
      mockSend.mockResolvedValueOnce(
        scenario === "unpaused" ? {} : { Item: marshall(marker) },
      );
    const claimed = claimPersonalMediaUploadJob({
      uploadId: job.uploadId,
      instanceId: "old",
      nowEpochSeconds: 100,
      claimExpiresAt: 200,
      updatedAt: "now",
      maxAttempts: 3,
      context,
      claimId: "claim",
      expectedAttempts: 1,
    });
    if (scenario === "unpaused") expect(await claimed).toEqual(job);
    else if (scenario === "paused")
      await expect(claimed).rejects.toMatchObject({ code: "paused" });
    else await expect(claimed).rejects.toThrow();
  },
);
test("submission classifies an atomic marker refusal without falling back to put", async () => {
  mockSend.mockImplementation(async (command) => {
    if (command.constructor.name === "TransactWriteItemsCommand")
      throw new TransactionCanceledException({
        $metadata: {},
        message: "synthetic conditional cancellation",
        CancellationReasons: [
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ],
      });
    return {};
  });
  expect(
    await submitPersonalMediaUploadJob({ ...job, status: "queued" }, context),
  ).toBe(false);
});

test("queue pages through paused and empty filtered pages before the batch limit", async () => {
  const paused = { ...job, status: "queued" };
  const ordinary = { ...paused, uploadId: "ordinary" };
  const cursor1 = marshall({ uploadId: "cursor-one" });
  const cursor2 = marshall({ uploadId: "cursor-two" });
  mockSend
    .mockResolvedValueOnce({
      Items: [marshall(paused)],
      LastEvaluatedKey: cursor1,
    })
    .mockResolvedValueOnce({
      Item: marshall(
        buildPausedDesktopDraftMarker(job, { operationId: "synthetic" }),
      ),
    })
    .mockResolvedValueOnce({ Items: [], LastEvaluatedKey: cursor2 })
    .mockResolvedValueOnce({ Items: [marshall(ordinary)] })
    .mockResolvedValueOnce({});
  await expect(
    listClaimablePersonalMediaUploadJobs({
      instanceId: "worker",
      nowEpochSeconds: 100,
      maxAttempts: 3,
      limit: 1,
    }),
  ).resolves.toEqual([ordinary]);
  expect(mockSend.mock.calls[2][0].input.ExclusiveStartKey).toEqual(cursor1);
  expect(mockSend.mock.calls[3][0].input.ExclusiveStartKey).toEqual(cursor2);
});
test.each(["malformed", "unavailable"])(
  "queue refuses %s pause state without returning the original",
  async (scenario) => {
    mockSend.mockResolvedValueOnce({ Items: [marshall(job)] });
    if (scenario === "unavailable")
      mockSend.mockRejectedValueOnce(new Error("read unavailable"));
    else
      mockSend.mockResolvedValueOnce({
        Item: marshall({
          pk: "UPLOAD#synthetic",
          sk: "PAUSED_DRAFT",
          recordType: "foreign",
        }),
      });
    await expect(
      listClaimablePersonalMediaUploadJobs({
        instanceId: "worker",
        nowEpochSeconds: 100,
        maxAttempts: 3,
        limit: 1,
      }),
    ).rejects.toThrow();
  },
);

test.each([
  ["missing", undefined],
  ["short", ["None", "None", "ConditionalCheckFailed"]],
  ["all none", ["None", "None", "None", "None"]],
  [
    "mixed unknown",
    ["None", "None", "ConditionalCheckFailed", "ValidationError"],
  ],
])(
  "incomplete or uncertain %s cancellation cannot settle a personal submission or claim",
  async (_name, codes) => {
    const failure = new TransactionCanceledException({
      $metadata: {},
      message: "synthetic uncertain cancellation",
      CancellationReasons: codes?.map((Code) => ({ Code })),
    });
    mockSend.mockRejectedValue(failure);
    await expect(
      submitPersonalMediaUploadJob({ ...job, status: "queued" }, context),
    ).rejects.toThrow();
    mockSend
      .mockReset()
      .mockResolvedValueOnce({
        Item: marshall({
          ...job,
          status: "queued",
          processingClaimId: "previous",
        }),
      })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(failure);
    await expect(
      claimPersonalMediaUploadJob({
        uploadId: job.uploadId,
        instanceId: "old",
        nowEpochSeconds: 100,
        claimExpiresAt: 200,
        updatedAt: "later",
        maxAttempts: 3,
        context,
        claimId: "new-claim",
        expectedAttempts: 1,
      }),
    ).rejects.toBe(failure);
    expect(mockSend.mock.calls.at(-1)?.[0].input.TransactItems).toHaveLength(4);
  },
);
