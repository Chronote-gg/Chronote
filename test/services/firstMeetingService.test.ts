/** @jest-environment node */
import { getFirstMeetingState } from "../../src/services/firstMeetingService";
import { getActiveMeetingLease } from "../../src/db";
import {
  getMeetingHistoryService,
  listRecentMeetingsForGuildService,
} from "../../src/services/meetingHistoryService";
import {
  ensureUserCanConnectChannel,
  ensureUserCanReadChannelHistory,
} from "../../src/services/discordPermissionsService";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "../../src/services/unifiedConfigService";
import type { MeetingHistory } from "../../src/types/db";

jest.mock("../../src/db", () => ({ getActiveMeetingLease: jest.fn() }));
jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(),
  listRecentMeetingsForGuildService: jest.fn(),
}));
jest.mock("../../src/services/discordPermissionsService", () => ({
  ensureUserCanConnectChannel: jest.fn(),
  ensureUserCanReadChannelHistory: jest.fn(),
}));
jest.mock("../../src/services/unifiedConfigService", () => ({
  resolveConfigSnapshot: jest.fn(),
  getSnapshotBoolean: jest.fn(),
}));

const guildId = "123456789012345678";
const userId = "234567890123456789";
const channelId = "345678901234567890";
const textChannelId = "456789012345678901";
const historyId = `${channelId}#2026-10-19T12:00:00.000Z`;
const history = (overrides: Partial<MeetingHistory> = {}): MeetingHistory => ({
  guildId,
  channelId_timestamp: historyId,
  channelId,
  textChannelId,
  meetingId: "internal-uuid",
  timestamp: "2026-10-19T12:00:00.000Z",
  meetingName: "Planning",
  participants: [],
  duration: 60,
  transcribeMeeting: true,
  generateNotes: true,
  status: "complete",
  ...overrides,
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(listRecentMeetingsForGuildService).mockResolvedValue([]);
  jest.mocked(getMeetingHistoryService).mockResolvedValue(history());
  jest.mocked(resolveConfigSnapshot).mockResolvedValue({
    values: {},
    experimentalEnabled: false,
    missingRequired: [],
  });
  jest.mocked(getSnapshotBoolean).mockReturnValue(true);
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(true);
  jest.mocked(ensureUserCanReadChannelHistory).mockResolvedValue(true);
});

test("selects_latest_accessible_candidate", async () => {
  const privateMeetingTitle = "Private leadership discussion";
  const accessibleHistoryId = `${channelId}#2026-10-18T12:00:00.000Z`;
  jest.mocked(listRecentMeetingsForGuildService).mockResolvedValue([
    history({ meetingName: privateMeetingTitle, channelId: "private" }),
    history({
      channelId_timestamp: accessibleHistoryId,
      timestamp: "2026-10-18T12:00:00.000Z",
    }),
  ]);
  jest
    .mocked(ensureUserCanConnectChannel)
    .mockImplementation(async ({ channelId }) => channelId !== "private");
  const result = await getFirstMeetingState({ guildId, userId });
  expect(result).toMatchObject({ meeting: { historyId: accessibleHistoryId } });
  expect(JSON.stringify(result)).not.toContain(privateMeetingTitle);
  expect(listRecentMeetingsForGuildService).toHaveBeenCalledWith(guildId, 50, {
    includeArchived: false,
  });
});

test("denied_target_matches_missing_target", async () => {
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(false);
  const deniedError = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  }).catch((error) => error);
  jest.mocked(getMeetingHistoryService).mockResolvedValue(undefined);
  const missingError = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  }).catch((error) => error);
  expect(deniedError.code).toBe("NOT_FOUND");
  expect(deniedError.code).toBe(missingError.code);
  expect(deniedError.message).toBe(missingError.message);
  expect(listRecentMeetingsForGuildService).not.toHaveBeenCalled();
});

test("honors_disabled_attendee_access_and_permission_unavailability", async () => {
  jest
    .mocked(getMeetingHistoryService)
    .mockResolvedValue(
      history({ participants: [{ id: userId, username: "Attendee" }] }),
    );
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(false);
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toHaveProperty("meeting.historyId", historyId);
  jest.mocked(getSnapshotBoolean).mockReturnValue(false);
  await expect(
    getFirstMeetingState({ guildId, userId, historyId }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(null);
  await expect(
    getFirstMeetingState({ guildId, userId, historyId }),
  ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  jest
    .mocked(resolveConfigSnapshot)
    .mockRejectedValue(new Error("config unavailable"));
  await expect(
    getFirstMeetingState({ guildId, userId, historyId }),
  ).rejects.toThrow("config unavailable");
});

test("empty_recent_activity_stays_generic", async () => {
  expect(await getFirstMeetingState({ guildId, userId })).toEqual({
    kind: "guide",
  });
  jest
    .mocked(listRecentMeetingsForGuildService)
    .mockResolvedValue([
      history({ channelId: "private", meetingName: "Private" }),
    ]);
  jest.mocked(ensureUserCanConnectChannel).mockResolvedValue(false);
  expect(await getFirstMeetingState({ guildId, userId })).toEqual({
    kind: "guide",
  });
});

const liveLease = () => ({
  guildId,
  meetingId: "internal-uuid",
  ownerInstanceId: "worker",
  executionVersion: 2,
  voiceChannelId: channelId,
  textChannelId,
  isAutoRecording: false,
  status: "in_progress" as const,
  leaseExpiresAt: Math.floor(Date.now() / 1000) + 60,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
  createdAt: "2026-10-19T12:00:00.000Z",
  updatedAt: "2026-10-19T12:00:00.000Z",
});
const notesDelivery = (
  outcome: "complete" | "partial" | "failed",
  sent = 2,
) => ({
  outcome,
  intended: 2,
  sent,
  errors: [],
});

test("lease_and_delivery_evidence", async () => {
  const active = history({
    status: "in_progress",
    ownerInstanceId: "worker",
    executionVersion: 2,
  });
  jest.mocked(getMeetingHistoryService).mockResolvedValue(active);
  jest.mocked(getActiveMeetingLease).mockResolvedValue(liveLease());
  expect(
    (await getFirstMeetingState({ guildId, userId, historyId })).kind,
  ).toBe("recording");
  jest
    .mocked(getActiveMeetingLease)
    .mockResolvedValue({ ...liveLease(), status: "processing" });
  expect(
    (await getFirstMeetingState({ guildId, userId, historyId })).kind,
  ).toBe("processing");
  jest
    .mocked(getActiveMeetingLease)
    .mockResolvedValue({ ...liveLease(), leaseExpiresAt: 1 });
  const expiredLeaseResult = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  });
  expect(expiredLeaseResult).toMatchObject({
    kind: "attention",
    reason: "status_unknown",
  });

  jest
    .mocked(getMeetingHistoryService)
    .mockResolvedValue(history({ notes: "Saved notes" }));
  const savedWithoutDelivery = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  });
  expect(savedWithoutDelivery.kind).toBe("saved");
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      notes: "Saved notes",
      delivery: { notes: notesDelivery("partial", 1) },
    }),
  );
  const partialResult = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  });
  expect(partialResult).toMatchObject({
    kind: "delivery_attention",
    delivery: "partial",
  });
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      notes: "Saved notes",
      delivery: { notes: notesDelivery("failed", 0) },
    }),
  );
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toMatchObject({ kind: "delivery_attention", delivery: "failed" });
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      notes: "Saved notes",
      notesChannelId: textChannelId,
      notesMessageIds: ["567890123456789012", "678901234567890123"],
      delivery: { notes: notesDelivery("complete") },
    }),
  );
  const completeDeliveryResult = await getFirstMeetingState({
    guildId,
    userId,
    historyId,
  });
  expect(completeDeliveryResult.kind).toBe("ready");
});

test.each([
  ["different meeting", { meetingId: "other" }],
  ["different guild", { guildId: "other" }],
  ["different owner", { ownerInstanceId: "other" }],
  ["different version", { executionVersion: 3 }],
  ["TTS session", { sessionMode: "tts_only" as const }],
])("unmatched_lease_is_unknown: %s", async (_label, mismatch) => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      status: "processing",
      ownerInstanceId: "worker",
      executionVersion: 2,
    }),
  );
  jest
    .mocked(getActiveMeetingLease)
    .mockResolvedValue({ ...liveLease(), ...mismatch });
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toMatchObject({ kind: "attention", reason: "status_unknown" });
});

test.each([
  ["whitespace", { notes: " \n\t" }, "no_notes"],
  ["skipped notes", { processing: { notes: "skipped" as const } }, "no_notes"],
  [
    "failed notes",
    { processing: { notes: "failed" as const } },
    "processing_failed",
  ],
  [
    "empty transcription",
    { processing: { transcription: "empty" as const } },
    "no_notes",
  ],
  [
    "failed transcription",
    { processing: { transcription: "failed" as const } },
    "processing_failed",
  ],
  ["cancelled", { status: "cancelled" as const }, "no_notes"],
  ["failed", { status: "failed" as const }, "processing_failed"],
  ["interrupted", { status: "interrupted" as const }, "interrupted"],
])("preserves_incomplete_outcomes: %s", async (_label, overrides, reason) => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(history(overrides));
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toMatchObject({ kind: "attention", reason });
});

test("preserves_warnings_without_content_or_provider_details", async () => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      notes: "PRIVATE NOTES BODY",
      transcript: "PRIVATE TRANSCRIPT",
      audioS3Key: "PRIVATE MEDIA",
      transcriptS3Key: "PRIVATE TRANSCRIPT KEY",
      status: "interrupted",
      capture: {
        kind: "interrupted",
        startedAt: null,
        endedAt: null,
        detectedAt: "2026-10-19T12:00:00.000Z",
      },
      recovery: {
        disposition: "needs_reconciliation",
        reason: "delivery_uncertain",
        stage: "delivery",
        attempt: 1,
        executionVersion: 2,
        retry: { maxAttempts: 3, nextAttemptAt: null },
      },
      delivery: {
        notes: {
          ...notesDelivery("failed", 0),
          errors: [{ status: 403, code: 50013 }],
        },
      },
    }),
  );
  const result = await getFirstMeetingState({ guildId, userId, historyId });
  expect(result).toMatchObject({
    kind: "delivery_attention",
    meeting: {
      captureNotice: expect.stringContaining("recording was interrupted"),
      recoveryNotice: expect.stringContaining("Recovery needs review"),
    },
  });
  const dto = JSON.stringify(result);
  for (const secret of [
    "PRIVATE",
    "50013",
    "delivery_uncertain",
    "audioS3Key",
    "transcript",
    '"notes"',
  ])
    expect(dto).not.toContain(secret);
  expect(result).toHaveProperty(
    "meeting.portalUrl",
    `http://localhost:5173/portal/meetings/${guildId}/${channelId}%232026-10-19T12%3A00%3A00.000Z`,
  );
});

test("discord_link_requires_permission_and_an_actual_pointer", async () => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      participants: [{ id: userId, username: "Attendee" }],
      summaryMessageId: "567890123456789012",
    }),
  );
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toHaveProperty(
    "meeting.discordUrl",
    `https://discord.com/channels/${guildId}/${textChannelId}/567890123456789012`,
  );
  jest.mocked(ensureUserCanReadChannelHistory).mockResolvedValue(false);
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toHaveProperty("meeting.discordUrl", null);
  jest.mocked(ensureUserCanReadChannelHistory).mockResolvedValue(null);
  await expect(
    getFirstMeetingState({ guildId, userId, historyId }),
  ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
});

test.each([
  { notesChannelId: undefined, textChannelId: undefined },
  {
    delivery: { notes: { ...notesDelivery("complete", 0), intended: 0 } },
    notesMessageIds: [],
  },
  { notesMessageIds: ["one"] },
  { notesMessageIds: ["one", "one"] },
  { notesMessageIds: ["one", " "] },
  {
    delivery: {
      notes: { ...notesDelivery("complete"), errors: [{ status: 403 }] },
    },
  },
  { delivery: { notes: notesDelivery("complete", 1) } },
])("incomplete_acknowledgment_does_not_claim_ready: %j", async (overrides) => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      notes: "Saved notes",
      notesChannelId: textChannelId,
      notesMessageIds: ["one", "two"],
      delivery: { notes: notesDelivery("complete") },
      ...overrides,
    }),
  );
  expect(
    (await getFirstMeetingState({ guildId, userId, historyId })).kind,
  ).toBe("saved");
});

test("matching_recovery_lease_verifies_offline_processing", async () => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      status: "interrupted",
      ownerInstanceId: "worker",
      executionVersion: 2,
    }),
  );
  jest.mocked(getActiveMeetingLease).mockResolvedValue({
    ...liveLease(),
    status: "processing",
    sessionMode: "recovery",
    recoveryAttemptId: "recovery-attempt",
  });
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toMatchObject({
    kind: "processing",
    meeting: {
      captureNotice: expect.stringContaining("recording was interrupted"),
    },
  });
});

test("saved_notes_take_priority_over_active_or_failed_processing", async () => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      status: "processing",
      notes: "Saved notes",
      processing: { notes: "failed" },
    }),
  );
  expect(
    (await getFirstMeetingState({ guildId, userId, historyId })).kind,
  ).toBe("saved");
  expect(getActiveMeetingLease).not.toHaveBeenCalled();
});

test("interrupted_history_cannot_resume_from_a_normal_voice_lease", async () => {
  jest.mocked(getMeetingHistoryService).mockResolvedValue(
    history({
      status: "interrupted",
      ownerInstanceId: "worker",
      executionVersion: 2,
    }),
  );
  jest.mocked(getActiveMeetingLease).mockResolvedValue(liveLease());
  expect(
    await getFirstMeetingState({ guildId, userId, historyId }),
  ).toMatchObject({ kind: "attention", reason: "interrupted" });
});
