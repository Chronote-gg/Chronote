/** @jest-environment node */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { randomUUID } from "node:crypto";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { getMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
import { processPersonalMediaUploadJob } from "../../src/services/personalMediaUploadWorkerService";
import { getRuntimeWorkAdmissionCheckpoints } from "../../src/services/runtimeWorkAdmissionService";
import { getRuntimeInstanceId } from "../../src/services/runtimeInstanceService";
import { processPersonalMediaUpload } from "../../src/services/personalMediaUploadProcessingService";
import { buildPausedDesktopDraftMarker } from "../../src/testSupport/personalMediaUploadFixtures";
import type { PersonalMediaUploadJobRecord } from "../../src/types/db";
import {
  seedServingRuntime,
  stopServingRuntime,
} from "../fixtures/servingRuntime";

jest.mock("../../src/services/personalMediaUploadProcessingService", () => ({
  createPersonalMediaProcessingMeeting: jest.fn(),
  processPersonalMediaUpload: jest.fn(),
}));

beforeEach(async () => {
  config.mock.enabled = true;
  getMockStore().personalMediaUploadsById.clear();
  await seedServingRuntime();
  jest.clearAllMocks();
});
afterEach(() => {
  config.mock.enabled = true;
  jest.restoreAllMocks();
});
afterAll(stopServingRuntime);

test.each([
  "paused",
  "lost claim ACK",
  "marker read failure",
  "malformed marker",
])("actual worker after queue selection: %s", async (scenario) => {
  let parent: PersonalMediaUploadJobRecord = {
    uploadId: randomUUID(),
    ownerUserId: "synthetic-owner",
    status: "queued",
    mediaKind: "audio",
    sourceS3Key: "synthetic/source",
    contentType: "audio/wav",
    fileSize: 10,
    createdAt: "now",
    updatedAt: "now",
  };
  let selected = false;
  let submissions = 0;
  const failure = new Error("synthetic unknown transport outcome");
  jest
    .spyOn(DynamoDBClient.prototype, "send")
    .mockImplementation(async (command) => {
      const input = command.input;
      if (command.constructor.name === "QueryCommand")
        return { Items: [marshall(parent)] };
      if (command.constructor.name === "GetItemCommand") {
        if ("Key" in input && input.Key?.uploadId)
          return { Item: marshall(parent) };
        if (!selected || scenario === "lost claim ACK") return {};
        if (scenario === "marker read failure") throw failure;
        const marker = buildPausedDesktopDraftMarker(parent);
        return {
          Item: marshall(
            scenario === "malformed marker"
              ? { ...marker, manifestSha256: "bad" }
              : marker,
          ),
        };
      }
      if (
        command.constructor.name === "TransactWriteItemsCommand" &&
        "TransactItems" in input
      ) {
        submissions++;
        expect(input.TransactItems).toHaveLength(4);
        parent = unmarshall(
          input.TransactItems![3].Put!.Item!,
        ) as PersonalMediaUploadJobRecord;
        throw failure;
      }
      throw new Error("Unexpected synthetic transport operation");
    });
  config.mock.enabled = false;
  const jobs = await getPersonalMediaUploadRepository().listClaimable({
    instanceId: getRuntimeInstanceId(),
    nowEpochSeconds: Math.floor(Date.now() / 1000),
    maxAttempts: 3,
    limit: 1,
  });
  expect(jobs).toEqual([parent]);
  selected = true;
  await processPersonalMediaUploadJob(jobs[0]);
  const owned = getRuntimeWorkAdmissionCheckpoints().filter(
    (row) => row.id === parent.uploadId,
  );
  expect(processPersonalMediaUpload).not.toHaveBeenCalled();
  if (scenario === "paused") {
    expect(owned).toHaveLength(0);
    expect(parent.status).toBe("queued");
  } else {
    expect(owned).toMatchObject([
      { stage: "unresolved", fenced: true, localSettled: true },
    ]);
  }
  expect(submissions).toBe(scenario === "lost claim ACK" ? 1 : 0);
  if (scenario === "lost claim ACK") expect(parent.status).toBe("processing");
});
