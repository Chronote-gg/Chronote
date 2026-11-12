/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import { createMockMeetingLeaseRepository } from "../../src/repositories/meetingLeaseRepository";
import { createMeetingLeaseService } from "../../src/services/meetingLease";
import type { ActiveMeetingLease } from "../../src/types/db";
import { historyRow } from "../repositories/meetingLeaseRepository.contract";
import {
  INSTANCE,
  NOW_MS,
  START_MS,
  button,
  meetingFor,
  setup,
  useSilencedCloseLogs,
} from "./meetingClose.fixture";

useSilencedCloseLogs();

test.each([
  {
    name: "a voice-only session leaves voice and releases the lease without writing a row",
    endReason: "leave_command",
  },
  {
    name: "a voice-only session ends through close and frees the server",
    endReason: "channel_empty",
  },
] as const)("$name", async ({ endReason }) => {
  const meeting = meetingFor("synthetic-tts", "tts_only");
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, { endReason });

  expect(t.calls).toEqual([
    "confirm",
    "stop:complete",
    "leave",
    "nickname",
    "retire",
    "release",
    "drop",
  ]);
  expect(t.deps.finish.recordCaptureEnd).not.toHaveBeenCalled();
  expect(t.deps.releaseCaptureProtection).not.toHaveBeenCalled();
  expect(t.starter).not.toHaveBeenCalled();
});

test("a live voice-only session does not keep protection on after the last recording closes", async () => {
  const lease = createMeetingLeaseService({
    repository: createMockMeetingLeaseRepository(
      new Map<string, ActiveMeetingLease>(),
      new Map(),
      new Map(),
    ),
    instanceId: () => INSTANCE,
    nowMs: () => NOW_MS,
    schedule: () => () => undefined,
  });
  async function admit(
    guildId: string,
    meetingId: string,
    sessionMode: "meeting" | "tts_only",
  ) {
    const shared = {
      guildId,
      meetingId,
      voiceChannelId: "synthetic-voice",
      textChannelId: "synthetic-text",
      isAutoRecording: false,
      reservedAt: START_MS,
    };
    const admission = await lease.acquireSessionLease(
      sessionMode === "meeting"
        ? {
            ...shared,
            sessionMode,
            history: {
              ...historyRow(meetingId),
              guildId,
              channelId_timestamp: `synthetic-voice#${meetingId}`,
            },
          }
        : { ...shared, sessionMode },
    );
    if (admission.kind !== "admitted") throw new Error("Expected admission");
    lease.startLeaseRenewal(admission.reservation, {
      maxDurationMs: 60 * 60_000,
      snapshot: () => ({ status: "in_progress" }),
      onEndRequested: () => undefined,
      onLost: () => undefined,
      onCapReached: () => undefined,
    });
    const meeting = meetingFor(meetingId, sessionMode);
    Object.assign(meeting, { reservation: admission.reservation });
    return meeting;
  }
  const recording = await admit(
    "synthetic-guild-a",
    "synthetic-meeting-a",
    "meeting",
  );
  await admit("synthetic-guild-b", "synthetic-tts", "tts_only");
  const t = setup([recording], { lease });

  await t.close.closeMeeting(recording, button);

  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});
