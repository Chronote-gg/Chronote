/** @jest-environment node */
import { buildPausedDesktopDraftMarker } from "../../testSupport/personalMediaUploadFixtures";
import { jest } from "@jest/globals";
import { buildDesktopJob } from "../../testSupport/personalMediaUploadFixtures";
import { getMockStore, resetMockStore } from "../../repositories/mockStore";
import { getPersonalMediaUploadRepository } from "../../repositories/personalMediaUploadRepository";
import { config } from "../configService";
import {
  createPersonalMediaProcessingMeeting,
  processPersonalMediaUpload,
} from "../personalMediaUploadProcessingService";
import {
  downloadObjectToFile,
  fetchJsonFromS3,
  uploadObjectToS3,
} from "../storageService";
import { createOpenAIClient } from "../openaiClient";
import { maybeAutoExportCompletedMeeting } from "../notionAutomationService";
import { writeMeetingUserIndexForMeetingService } from "../meetingUserIndexService";
import { generateOpenAINotes } from "../openaiTextService";

jest.mock("../storageService", () => ({
  downloadObjectToFile: jest.fn(),
  fetchJsonFromS3: jest.fn(),
  uploadObjectToS3: jest.fn(),
}));
jest.mock("../openaiClient", () => ({ createOpenAIClient: jest.fn() }));
jest.mock("../openaiTextService", () => ({ generateOpenAINotes: jest.fn() }));
jest.mock("../notionAutomationService", () => ({
  maybeAutoExportCompletedMeeting: jest.fn(),
}));
jest.mock("../meetingUserIndexService", () => ({
  writeMeetingUserIndexForMeetingService: jest.fn(),
}));

beforeEach(() => {
  resetMockStore();
  config.mock.enabled = true;
  jest.clearAllMocks();
});
afterEach(() => jest.restoreAllMocks());
test.each([createPersonalMediaProcessingMeeting, processPersonalMediaUpload])(
  "paused original refuses direct %p before any processing effects",
  async (entry) => {
    const job = buildDesktopJob();
    const original = structuredClone(job);
    getMockStore().personalMediaUploadsById.set(job.uploadId, original);
    const histories = structuredClone(getMockStore().meetingHistoryByGuild);
    const writeHistory = jest.spyOn(
      getPersonalMediaUploadRepository(),
      "writeHistory",
    );
    const marker = buildPausedDesktopDraftMarker(job, {
      operationId: "synthetic",
    });
    getMockStore().deploymentControlRecords.set(
      JSON.stringify([marker.pk, marker.sk]),
      marker,
    );
    await expect(entry(job, "instance-1")).rejects.toMatchObject({
      code: "paused",
    });
    expect(job).toEqual(original);
    expect(getMockStore().personalMediaUploadsById.get(job.uploadId)).toEqual(
      original,
    );
    expect(getMockStore().meetingHistoryByGuild).toEqual(histories);
    expect(writeHistory).not.toHaveBeenCalled();
    expect(writeMeetingUserIndexForMeetingService).not.toHaveBeenCalled();
    expect(downloadObjectToFile).not.toHaveBeenCalled();
    expect(uploadObjectToS3).not.toHaveBeenCalled();
    expect(fetchJsonFromS3).not.toHaveBeenCalled();
    expect(createOpenAIClient).not.toHaveBeenCalled();
    expect(generateOpenAINotes).not.toHaveBeenCalled();
    expect(maybeAutoExportCompletedMeeting).not.toHaveBeenCalled();
  },
);
