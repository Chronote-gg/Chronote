import {
  finalizationFixture,
  successfulArtifactUpload,
} from "../fixtures/endMeeting";
import type { Client } from "discord.js";
import { runEndMeetingFlow } from "../../src/commands/endMeeting";
import { getNotes } from "../../src/services/notesService";
import { ensureMeetingNotes } from "../../src/services/meetingNotesService";
import { interruptOwnedMeeting } from "../../src/services/ownedMeetingInterruption";
import { releaseMeetingLeaseForMeeting } from "../../src/services/activeMeetingLeaseService";
import { cleanupMeetingTempDir } from "../../src/services/tempFileService";
import { closeOutputFile, cleanupSpeakerTracks } from "../../src/audio";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { evaluateAutoRecordCancellation } from "../../src/services/autoRecordCancellationService";
import { uploadMeetingArtifacts } from "../../src/services/uploadService";
import { getGuildLimits } from "../../src/services/subscriptionService";
import { compileTranscriptions } from "../../src/services/transcriptCompilationService";
import { transitionOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { updateMeetingSummaryMessage } from "../../src/embed";
import { deleteIfExists } from "../../src/util";
import { captureEvent } from "../../src/services/analyticsService";

describe("incomplete capture preserves failure and artifact safeguards", () => {
  let errorOutput: jest.SpiedFunction<typeof console.error>;
  beforeEach(() => {
    jest.clearAllMocks();
    errorOutput = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    jest.mocked(releaseMeetingLeaseForMeeting).mockResolvedValue(true);
    jest.mocked(cleanupMeetingTempDir).mockResolvedValue(undefined);
    jest.mocked(closeOutputFile).mockResolvedValue(undefined);
    jest.mocked(saveMeetingHistoryToDatabase).mockResolvedValue(undefined);
    jest
      .mocked(evaluateAutoRecordCancellation)
      .mockResolvedValue({ cancel: false });
    jest
      .mocked(uploadMeetingArtifacts)
      .mockResolvedValue(successfulArtifactUpload);
    jest.mocked(getGuildLimits).mockResolvedValue({ limits: {} } as never);
    jest.mocked(compileTranscriptions).mockResolvedValue("Fixture speech");
    jest.mocked(updateMeetingSummaryMessage).mockReset();
    jest
      .mocked(transitionOwnedMeetingHistoryService)
      .mockResolvedValue(undefined);
  });
  afterEach(() => errorOutput.mockRestore());
  it.each([false, true])(
    "caught notes-provider failure cannot complete with captureIncomplete=%s",
    async (captureIncomplete) => {
      const actual = jest.requireActual<
        typeof import("../../src/services/meetingNotesService")
      >("../../src/services/meetingNotesService");
      jest
        .mocked(ensureMeetingNotes)
        .mockImplementationOnce(actual.ensureMeetingNotes);
      jest
        .mocked(getNotes)
        .mockRejectedValueOnce(new Error("fixture provider unavailable"));
      const meeting = finalizationFixture();
      meeting.transcribeMeeting = true;
      meeting.generateNotes = true;
      meeting.audioData.captureIncomplete = captureIncomplete;
      meeting.audioData.audioFiles = [
        { transcript: "Fixture speech", processing: false },
      ] as never;
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).rejects.toThrow("processing");
      expect(meeting.processing?.notes).toBe("failed");
      expect(errorOutput).toHaveBeenCalledWith(
        "Error generating meeting notes:",
        expect.objectContaining({ message: "fixture provider unavailable" }),
      );
      expect(jest.mocked(saveMeetingHistoryToDatabase)).not.toHaveBeenCalled();
      expect(jest.mocked(deleteIfExists)).not.toHaveBeenCalled();
      expect(jest.mocked(releaseMeetingLeaseForMeeting)).not.toHaveBeenCalled();
      expect(interruptOwnedMeeting).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({ reason: "processing_failure" }),
      );
    },
  );
  it.each([
    ["audio", false],
    ["chat", false],
    ["transcript", false],
    ["audio", true],
    ["chat", true],
    ["transcript", true],
  ] as const)(
    "missing expected %s never commits complete or deletes artifacts with captureIncomplete=%s",
    async (missing, captureIncomplete) => {
      const meeting = finalizationFixture();
      meeting.audioData.captureIncomplete = captureIncomplete;
      if (captureIncomplete) {
        meeting.transcribeMeeting = true;
        meeting.audioData.audioFiles = [
          { transcript: "Fixture speech", processing: false },
        ] as never;
      }
      const upload = {
        audioUploadExpected: true,
        chatUploadExpected: true,
        transcriptUploadExpected: true,
        audioS3Key: "audio",
        chatS3Key: "chat",
        transcriptS3Key: "transcript",
      };
      delete (upload as Partial<typeof upload>)[`${missing}S3Key`];
      jest.mocked(uploadMeetingArtifacts).mockResolvedValueOnce(upload);
      await expect(
        runEndMeetingFlow({ client: {} as Client, meeting }),
      ).rejects.toThrow("artifact");
      expect(jest.mocked(saveMeetingHistoryToDatabase)).not.toHaveBeenCalled();
      expect(jest.mocked(deleteIfExists)).not.toHaveBeenCalled();
      expect(jest.mocked(cleanupSpeakerTracks)).not.toHaveBeenCalled();
      expect(jest.mocked(releaseMeetingLeaseForMeeting)).not.toHaveBeenCalled();
      expect(captureEvent).not.toHaveBeenCalled();
      expect(interruptOwnedMeeting).toHaveBeenCalledWith(
        meeting,
        expect.objectContaining({ reason: "processing_failure" }),
      );
      expect(errorOutput).toHaveBeenCalledWith(
        "Expected meeting artifacts were not durably uploaded; retained local artifacts",
        expect.objectContaining({
          meetingId: meeting.meetingId,
          reason: "artifact_upload_failed",
        }),
      );
    },
  );
});
