/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { getDeploymentControlRepository } from "../../src/db";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { getPersonalRecordingSegmentRepository } from "../../src/repositories/personalRecordingSegmentRepository";
import { getMockStore } from "../../src/repositories/mockStore";
import {
  requireUnpausedDesktopDraft,
  getPausedDesktopDraft,
} from "../../src/repositories/pausedDesktopDraft";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";
import { context, control, runtime } from "../deployment/controlFixtures";
import { buildPausedDesktopDraftInstallationTransaction } from "../../src/services/pausedDesktopDraftTransactions";
import {
  createDynamoDeploymentControlRepository,
  createMockDeploymentControlRepository,
} from "../../src/repositories/deploymentControlRepository";
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import type {
  PausedDesktopDraftInstallation,
  DeploymentControlRecord,
} from "../../src/types/deploymentControl";

const job: PersonalMediaUploadJobRecord = {
  uploadId: "synthetic-paused",
  ownerUserId: "synthetic-owner",
  status: "pending_upload",
  mediaKind: "audio",
  sourceS3Key: "source",
  contentType: "audio/wav",
  fileSize: 10,
  createdAt: "now",
  updatedAt: "now",
};
const marker = buildPausedDesktopDraftMarker(job);

beforeEach(() => {
  const store = getMockStore();
  store.personalMediaUploadsById.set(job.uploadId, structuredClone(job));
  store.deploymentControlRecords.clear();
  for (const row of [control, runtime("old"), marker])
    store.deploymentControlRecords.set(
      JSON.stringify([row.pk, row.sk]),
      structuredClone(row),
    );
});
test("shared lookup exposes structured pause and refuses foreign or invalid bindings", async () => {
  const repository = getDeploymentControlRepository();
  expect(await getPausedDesktopDraft(repository, job)).toEqual(marker);
  await expect(
    requireUnpausedDesktopDraft(repository, job),
  ).rejects.toMatchObject({ code: "paused" });
  await expect(
    getPausedDesktopDraft(repository, { ...job, ownerUserId: "other" }),
  ).rejects.toThrow();
  getMockStore().deploymentControlRecords.set(
    JSON.stringify([marker.pk, marker.sk]),
    { ...marker, pk: "UPLOAD#other" },
  );
  await expect(getPausedDesktopDraft(repository, job)).rejects.toThrow();
  await expect(
    getPausedDesktopDraft(
      {
        getRecord: async () => {
          throw new Error("unavailable");
        },
      },
      job,
    ),
  ).rejects.toThrow("unavailable");
});
test("mock submission and all claim paths refuse key existence", async () => {
  const repository = getPersonalMediaUploadRepository();
  expect(await repository.submit({ ...job, status: "queued" })).toBe(false);
  for (const state of [
    { status: "queued" as const },
    {
      status: "processing" as const,
      processingClaimId: "claim",
      processingOwnerInstanceId: "old",
      claimExpiresAt: 160,
      attempts: 1,
    },
    {
      status: "processing" as const,
      processingClaimId: "expired",
      processingOwnerInstanceId: "old",
      claimExpiresAt: 99,
      attempts: 1,
    },
  ]) {
    getMockStore().personalMediaUploadsById.set(job.uploadId, {
      ...job,
      ...state,
    });
    expect(
      await repository.claim({
        uploadId: job.uploadId,
        instanceId: "old",
        nowEpochSeconds: 100,
        claimExpiresAt: 160,
        updatedAt: "later",
        maxAttempts: 3,
        context,
        claimId: "claim",
        expectedAttempts: state.attempts ?? 0,
      }),
    ).toBeUndefined();
  }
  getMockStore().deploymentControlRecords.delete(
    JSON.stringify([marker.pk, marker.sk]),
  );
  getMockStore().personalMediaUploadsById.set(job.uploadId, job);
  expect(await repository.submit({ ...job, status: "queued" })).toBe(true);
});
test("mock late segment prepare and transition refuse key existence", async () => {
  const segment = {
    uploadId: job.uploadId,
    ownerUserId: job.ownerUserId,
    segmentKey: "source#0",
    sourceId: "source",
    sequence: 0,
    kind: "owner_mic" as const,
    label: "Synthetic",
    sourceS3Key: "source",
    contentType: "audio/wav",
    fileSize: 10,
    checksumSha256: "a".repeat(64),
    durationMillis: 100,
    startedAt: "now",
    endedAt: "later",
    status: "pending_upload" as const,
    createdAt: "now",
    updatedAt: "now",
  };
  const repository = getPersonalRecordingSegmentRepository();
  await repository.write(segment);
  expect(await repository.prepare(segment, "pending_upload")).toBe(false);
  expect(
    await repository.transition(
      { ...segment, status: "uploaded" },
      "pending_upload",
    ),
  ).toBe(false);
});
function installation(): PausedDesktopDraftInstallation {
  const first = {
    record: marker,
    expectedParent: { ...job, uploadOrigin: "desktop_recording" as const },
  };
  const second = {
    record: {
      ...marker,
      uploadId: "synthetic-second",
      pk: "UPLOAD#synthetic-second",
    },
    expectedParent: { ...first.expectedParent, uploadId: "synthetic-second" },
  };
  return {
    control: { ...control, servingMembers: {} },
    coordinatorToken: control.coordinatorToken,
    coordinatorEpoch: control.coordinatorEpoch,
    now: 100,
    pairs: [first, second],
  };
}
const tables = {
  deploymentControl: "synthetic-control",
  personalMediaUpload: "synthetic-upload",
  meetingHistory: "synthetic-history",
};
test("installation requires closed exact authority, one cohort and unclaimed parents", () => {
  const invalid: PausedDesktopDraftInstallation[] = [
    { ...installation(), control },
    { ...installation(), coordinatorToken: "other" },
    { ...installation(), coordinatorEpoch: 4 },
    { ...installation(), now: 200 },
  ];
  for (const field of [
    "operationId",
    "manifestSha256",
    "preservedCaptureSha256",
  ] as const) {
    const input = installation();
    input.pairs[1].record = {
      ...input.pairs[1].record,
      [field]: field === "operationId" ? "other" : "c".repeat(64),
    };
    invalid.push(input);
  }
  for (const patch of [
    { processingClaimId: "held" },
    { processingOwnerInstanceId: "old" },
    { claimExpiresAt: 99 },
    { attempts: 1 },
    { artifactAttempts: {} },
    { status: "processing" as const },
    { ownerUserId: "other" },
  ]) {
    const input = installation();
    input.pairs[0].expectedParent = {
      ...input.pairs[0].expectedParent,
      ...patch,
    };
    invalid.push(input);
  }
  const duplicate = installation();
  duplicate.pairs = [duplicate.pairs[0], duplicate.pairs[0]];
  invalid.push(duplicate);
  invalid.forEach((input) =>
    expect(() =>
      buildPausedDesktopDraftInstallationTransaction(input, tables),
    ).toThrow(),
  );
});
test("mock installation refuses the entire cohort on conflict and permits exact readback", async () => {
  const input = installation();
  const records = new Map<string, DeploymentControlRecord>([
    [JSON.stringify(["ENV", "CONTROL"]), input.control],
  ]);
  const uploads = new Map(
    input.pairs.map((pair) => [
      pair.expectedParent.uploadId,
      pair.expectedParent,
    ]),
  );
  const repository = createMockDeploymentControlRepository(
    records,
    undefined,
    undefined,
    uploads,
  );
  records.set(JSON.stringify([marker.pk, marker.sk]), {
    ...marker,
    operationId: "other",
  });
  expect(await repository.installPausedDesktopDrafts(input)).toBe("stale");
  expect(
    await repository.getRecord(input.pairs[1].record.pk, "PAUSED_DRAFT"),
  ).toBeUndefined();
  records.delete(JSON.stringify([marker.pk, marker.sk]));
  expect(await repository.installPausedDesktopDrafts(input)).toBe("applied");
  for (const pair of input.pairs)
    expect(await repository.getRecord(pair.record.pk, pair.record.sk)).toEqual(
      pair.record,
    );
  expect(await repository.installPausedDesktopDrafts(input)).toBe("stale");
});
test("bound mock repository uses shared upload parents for paused-draft installation", async () => {
  const input = installation();
  const store = getMockStore();
  store.deploymentControlRecords.clear();
  store.deploymentControlRecords.set(
    JSON.stringify(["ENV", "CONTROL"]),
    input.control,
  );
  for (const { expectedParent } of input.pairs)
    store.personalMediaUploadsById.set(expectedParent.uploadId, expectedParent);
  const repository = getDeploymentControlRepository();
  expect(await repository.installPausedDesktopDrafts(input)).toBe("applied");
  expect(
    await repository.getRecord(input.pairs[1].record.pk, "PAUSED_DRAFT"),
  ).toEqual(input.pairs[1].record);
});
test.each([
  { name: "TimeoutError", code: "ETIMEDOUT" },
  { name: "Error", code: "ECONNRESET" },
])(
  "an unknown installation acknowledgment stops SDK replay on $code",
  async (errorIdentity) => {
    const failure = Object.assign(
      new Error("unknown acknowledgment"),
      errorIdentity,
    );
    const handle = jest.fn(async () => {
      throw failure;
    });
    const client = new DynamoDBClient({
      region: "local",
      credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
      maxAttempts: 3,
      retryMode: "standard",
      cacheMiddleware: true,
      requestHandler: { handle },
    });
    const repository = createDynamoDeploymentControlRepository(client, tables);
    const ordinaryWrite = () =>
      client.send(
        new TransactWriteItemsCommand(
          buildPausedDesktopDraftInstallationTransaction(
            installation(),
            tables,
          ),
        ),
      );
    try {
      await expect(ordinaryWrite()).rejects.toBe(failure);
      expect(handle).toHaveBeenCalledTimes(3);
      handle.mockClear();
      await expect(
        repository.installPausedDesktopDrafts(installation()),
      ).rejects.toMatchObject({
        kind: "unavailable",
        cause: failure,
      });
      expect(handle).toHaveBeenCalledTimes(1);
      handle.mockClear();
      await expect(ordinaryWrite()).rejects.toBe(failure);
      expect(handle).toHaveBeenCalledTimes(3);
      handle.mockClear();
      await expect(repository.getRecord("ENV", "CONTROL")).rejects.toBe(
        failure,
      );
      expect(handle).toHaveBeenCalledTimes(3);
    } finally {
      client.destroy();
    }
  },
);
