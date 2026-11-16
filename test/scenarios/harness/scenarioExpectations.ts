import { sumMeetingSecondsInWindow } from "../../../src/services/meetingUsageService";
import type { MeetingHistory } from "../../../src/types/db";
import { EMPTY_RECORDING_NOTICE } from "../../../src/utils/meetingProcessing";
import {
  embedText,
  expectDeliveredOnce,
  type Scenario,
  type ScenarioServer,
  until,
  WEEK_MS,
} from "./scenario";

/** Queues a portal stop for `meetingId` addressed to `instanceId` and waits until a worker answers it. */
export async function stopAddressedTo(
  scenario: Scenario,
  server: ScenarioServer,
  meetingId: string,
  instanceId: string,
) {
  const requestId = await scenario.queueControl(
    "stop_meeting",
    server,
    { serverId: server.guildId, meetingId },
    instanceId,
  );
  return until(async () => {
    const command = await scenario.controlCommand(requestId);
    return command?.queueStatus === "pending" ? undefined : command;
  }, "stop command answered");
}

/**
 * A button-ended meeting with no usable speech: complete with no notes, the
 * no-speech notice delivered once from the start message, and no time metered.
 */
export function expectEmptyRecordingDelivered(
  scenario: Scenario,
  done: MeetingHistory,
  startMessage: string,
) {
  expect(done).toMatchObject({
    status: "complete",
    endReason: "button",
    capture: { kind: "complete" },
    processing: { transcription: "empty", notes: "skipped" },
  });
  expect(done.notes).toBeUndefined();
  const posted = expectDeliveredOnce(scenario, done);
  expect(posted[0].id).toBe(startMessage);
  expect(posted.map(embedText).join()).toContain(EMPTY_RECORDING_NOTICE);
  expect(sumMeetingSecondsInWindow([done], 0, Date.now() + WEEK_MS)).toBe(0);
}
