/** @jest-environment node */
import { beforeEach, describe, expect, test, jest } from "@jest/globals";
import "../deployment/coldNetworkGuard.cjs";
import type { MeetingHistory } from "../../src/types/db";
import type { ProcessingRetryJob } from "../../src/types/meetingProcessingRetry";
import { getMockUser } from "../../src/repositories/mockStore";
import { getMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { checkUserMeetingAccess } from "../../src/services/meetingAccessService";
import { ensureUserCanManageChannel } from "../../src/services/discordPermissionsService";
import { requestProcessingRetry } from "../../src/services/processingRetryRequestService";
import { isProcessingRetryAvailable } from "../../src/services/processingRetryAvailability";
import { resolveProcessingRetryView } from "../../src/trpc/routers/meetingProcessingRetry";
import { history } from "../types/meetingUpdateDelivery.fixture";
import { buildCaller } from "../utils/trpcCaller";

jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
}));
jest.mock("../../src/services/meetingAccessService", () => ({
  checkUserMeetingAccess: jest.fn(),
  resolvePersonalMeetingSharedGuildIds: jest.fn(async () => undefined),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanManageChannel: jest.fn(),
}));
jest.mock("../../src/services/attendeeAccessSetting", () => ({
  resolveAttendeeAccessEnabled: jest.fn(async () => true),
}));
jest.mock("../../src/services/processingRetryRequestService", () => ({
  requestProcessingRetry: jest.fn(),
}));
jest.mock("../../src/services/processingRetryAvailability", () => ({
  isProcessingRetryAvailable: jest.fn(),
}));

const user = getMockUser();
const otherUserId = "999999999999999980";
const failedNotes = (patch: Partial<MeetingHistory> = {}): MeetingHistory => ({
  ...history(),
  status: "complete",
  notes: undefined,
  transcriptS3Key: "t/transcript.json",
  processing: { transcription: "ready", notes: "failed", summary: "skipped" },
  meetingCreatorId: user.id,
  ...patch,
});
const meeting = failedNotes();
const retryJob = (
  patch: Partial<ProcessingRetryJob> = {},
): ProcessingRetryJob => ({
  jobId: "job-1",
  status: "queued",
  stages: ["notes", "summary"],
  requestedBy: user.id,
  requestedAt: "2026-10-28T12:00:00.000Z",
  expectedNotesVersion: 1,
  replaceNotes: false,
  countedAttempts: 0,
  settingsSource: "current",
  transcriptSource: "existing",
  updatedAt: "2026-10-28T12:00:00.000Z",
  ...patch,
});
const input = {
  serverId: meeting.guildId,
  meetingId: meeting.channelId_timestamp,
};

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(checkUserMeetingAccess).mockResolvedValue({
    allowed: true,
    via: "owner",
  });
  jest.mocked(getMeetingHistoryService).mockResolvedValue(meeting);
  jest.mocked(isProcessingRetryAvailable).mockResolvedValue(true);
});

describe("meetings.retryProcessing", () => {
  test("the meeting owner queues a retry with replaceNotes passed through", async () => {
    const job = retryJob({ replaceNotes: true });
    jest.mocked(requestProcessingRetry).mockResolvedValue({
      kind: "queued",
      job,
      history: { ...meeting, processingRetry: job },
    });

    const result = await buildCaller().meetings.retryProcessing({
      ...input,
      replaceNotes: true,
    });

    expect(requestProcessingRetry).toHaveBeenCalledWith({
      key: { guildId: input.serverId, channelId_timestamp: input.meetingId },
      requestedBy: user.id,
      replaceNotes: true,
      source: "portal",
    });
    expect(result.processingRetry).toMatchObject({
      eligible: false,
      reason: "job_active",
      status: "queued",
      settingsSource: "current",
    });
  });

  test("a viewer who cannot edit notes is forbidden and nothing is requested", async () => {
    jest
      .mocked(getMeetingHistoryService)
      .mockResolvedValue(failedNotes({ meetingCreatorId: otherUserId }));

    await expect(
      buildCaller().meetings.retryProcessing(input),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Only the meeting starter can retry processing for this meeting.",
    });
    expect(requestProcessingRetry).not.toHaveBeenCalled();
  });

  test("auto-recorded meetings accept ManageChannels", async () => {
    jest
      .mocked(getMeetingHistoryService)
      .mockResolvedValue(
        failedNotes({ meetingCreatorId: otherUserId, isAutoRecording: true }),
      );
    jest.mocked(ensureUserCanManageChannel).mockResolvedValue(true);
    jest.mocked(requestProcessingRetry).mockResolvedValue({
      kind: "conflict",
    });

    await expect(
      buildCaller().meetings.retryProcessing(input),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(ensureUserCanManageChannel).toHaveBeenCalledWith({
      guildId: input.serverId,
      channelId: meeting.channelId,
      userId: user.id,
    });
    expect(requestProcessingRetry).toHaveBeenCalledWith(
      expect.objectContaining({ replaceNotes: false }),
    );
  });

  test("a missing meeting is not found", async () => {
    jest.mocked(getMeetingHistoryService).mockResolvedValue(undefined);
    await expect(
      buildCaller().meetings.retryProcessing(input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test.each([
    [
      { kind: "unavailable" as const },
      "PRECONDITION_FAILED",
      "Processing retry is not available yet.",
    ],
    [
      {
        kind: "ineligible" as const,
        reason: "replace_confirmation_required" as const,
      },
      "BAD_REQUEST",
      "Confirm replacing the existing notes to retry.",
    ],
    [
      { kind: "ineligible" as const, reason: "notes_edited" as const },
      "PRECONDITION_FAILED",
      "This meeting cannot be retried right now.",
    ],
    [
      { kind: "conflict" as const },
      "CONFLICT",
      "The meeting changed. Refresh and try again.",
    ],
  ])("maps %o to %s", async (result, code, message) => {
    jest.mocked(requestProcessingRetry).mockResolvedValue(result);
    await expect(
      buildCaller().meetings.retryProcessing(input),
    ).rejects.toMatchObject({ code, message });
  });
});

describe("resolveProcessingRetryView", () => {
  const viewFor = (history: MeetingHistory) =>
    resolveProcessingRetryView({
      history,
      serverId: input.serverId,
      channelId: meeting.channelId ?? "",
      user: { id: user.id },
    });

  test("is unavailable when the flag is off", async () => {
    jest.mocked(isProcessingRetryAvailable).mockResolvedValue(false);
    expect(await viewFor(meeting)).toMatchObject({
      eligible: false,
      reason: "unavailable",
    });
    expect(checkUserMeetingAccess).not.toHaveBeenCalled();
  });

  test("reports not_permitted, not an error, when the permission check throws", async () => {
    jest.mocked(checkUserMeetingAccess).mockResolvedValue({
      allowed: null,
      missing: [],
    });
    expect(await viewFor(meeting)).toMatchObject({
      eligible: false,
      reason: "not_permitted",
    });
  });

  test("is eligible for an editor", async () => {
    expect(await viewFor(meeting)).toEqual({
      eligible: true,
      reason: undefined,
      requiresReplaceConfirm: false,
      status: undefined,
      failureReason: undefined,
      settingsSource: undefined,
      attemptsRemaining: 3,
    });
  });

  test("reports a row with an unreadable notes version as unavailable", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      await viewFor(
        failedNotes({ notes: "Generated notes", notesVersion: -4 }),
      ),
    ).toMatchObject({
      eligible: false,
      reason: "unavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      "Unreadable processing retry state",
      expect.anything(),
    );
  });

  test.each([
    ["an eligible meeting", {}],
    ["a queued job", { processingRetry: retryJob() }],
    [
      "a failed job",
      {
        processingRetry: retryJob({
          status: "failed",
          failureReason: "stage_failed",
          countedAttempts: 1,
        }),
      },
    ],
  ])("gives a non-editor no job fields for %s", async (_, patch) => {
    const view = await viewFor(
      failedNotes({ meetingCreatorId: otherUserId, ...patch }),
    );
    expect(view).toEqual({
      eligible: false,
      reason: "not_permitted",
      requiresReplaceConfirm: false,
      attemptsRemaining: 0,
    });
  });

  test("hides a queued job from a non-editor even while retry is unavailable", async () => {
    jest.mocked(isProcessingRetryAvailable).mockResolvedValue(false);
    const view = await viewFor(
      failedNotes({
        meetingCreatorId: otherUserId,
        processingRetry: retryJob(),
      }),
    );
    expect(view.reason).toBe("not_permitted");
    expect(view.status).toBeUndefined();
  });

  test("skips the permission check when nothing would be shown", async () => {
    const view = await viewFor(
      failedNotes({
        meetingCreatorId: otherUserId,
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
        notes: "Generated notes",
      }),
    );
    expect(view.reason).toBe("nothing_failed");
    expect(checkUserMeetingAccess).not.toHaveBeenCalled();
  });

  test("reports unavailable when the flag cannot be read", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest
      .mocked(isProcessingRetryAvailable)
      .mockRejectedValue(new Error("config read failed"));
    expect(await viewFor(meeting)).toMatchObject({
      eligible: false,
      reason: "unavailable",
    });
    expect(warn).toHaveBeenCalled();
  });
});
