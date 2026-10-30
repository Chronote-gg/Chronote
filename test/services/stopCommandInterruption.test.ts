/** @jest-environment node */
import {
  mockStopEnvironment,
  deferredStopEffect as held,
  stoppedRecordingFixture,
} from "../fixtures/stopInterruptionEnvironment";
import type { Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingControlCommand } from "../../src/types/meetingControl";
import { processMeetingControlCommand } from "../../src/services/meetingControlWorkerService";
import { runEndMeetingFlow } from "../../src/commands/endMeeting";
import { getMeetingInterruptionCheckpoints } from "../../src/services/ownedMeetingInterruption";
import { getRuntimeWorkAdmissionCheckpoints } from "../../src/services/runtimeWorkAdmissionService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => {
    throw new Error("Unexpected independent work");
  },
}));
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => ({
    getMeetingHistory: () => mockStopEnvironment.terminalRead(),
  }),
}));
test.each(["acknowledged", "lost_ack", "changed_original"] as const)(
  "actual stop-command finalization failure handles %s without releasing before actual parent effects",
  async (outcome) => {
    jest.clearAllMocks();
    mockStopEnvironment.ownership = new AbortController();
    mockStopEnvironment.reservations.length = 0;
    mockStopEnvironment.repository.failCommand.mockReset();
    if (outcome === "lost_ack")
      mockStopEnvironment.repository.failCommand.mockRejectedValue(
        new Error("Synthetic lost terminal ACK"),
      );
    else mockStopEnvironment.repository.failCommand.mockResolvedValue(true);
    const cleanup = held();
    mockStopEnvironment.close.mockReturnValue(cleanup.promise);
    const { original, childSettled } = stoppedRecordingFixture(
      `synthetic-parent-${outcome}`,
    );
    const client = {
      guilds: {
        cache: new Map([
          [
            original.guildId,
            { members: { cache: new Map([["synthetic-user", {}]]) } },
          ],
        ]),
      },
    } as unknown as Client;
    mockStopEnvironment.meeting = {
      ...original,
      reservation: original,
      creator: { id: "synthetic-user" },
      channelId: "voice",
      startTime: new Date(0),
      setFinished: jest.fn(),
      audioData: {},
      recordingCapture: {
        finish: jest.fn(async () => {
          if (outcome === "changed_original") {
            original.executionVersion += 1;
            mockStopEnvironment.ownership.abort();
          }
          throw new Error("Synthetic processing failure");
        }),
        fence: jest.fn(),
        settled: async () => {},
        releaseSettledBuffers: jest.fn(),
      },
      onEndMeeting: (meeting: MeetingData) =>
        runEndMeetingFlow({ client, meeting }),
    } as unknown as MeetingData;
    const command: MeetingControlCommand = {
      requestId: `synthetic-stop-parent-${outcome}`,
      commandType: "stop_meeting",
      queueStatus: "pending",
      userId: "synthetic-user",
      input: { serverId: original.guildId, meetingId: original.meetingId },
      createdAt: "synthetic",
      updatedAt: "synthetic",
      expiresAt: 9_999_999_999,
    };
    mockStopEnvironment.repository.claimCommand.mockResolvedValue(command);
    try {
      await processMeetingControlCommand(client, command);
      expect(mockStopEnvironment.repository.failCommand).toHaveBeenCalledTimes(
        outcome === "changed_original" ? 0 : 1,
      );
      expect(
        mockStopEnvironment.repository.completeCommand,
      ).not.toHaveBeenCalled();
      expect(mockStopEnvironment.reconcile).not.toHaveBeenCalled();
      expect(mockStopEnvironment.meeting.setFinished).not.toHaveBeenCalled();
      cleanup.release();
      const interruption = getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockStopEnvironment.meeting,
      )!;
      expect(await interruption.actual).toEqual({
        kind: outcome === "acknowledged" ? "settled" : "unresolved",
      });
      expect(childSettled).toHaveBeenCalledTimes(
        outcome === "acknowledged" ? 1 : 0,
      );
      const claim = getRuntimeWorkAdmissionCheckpoints().find(
        ({ id }) => id === command.requestId,
      );
      if (outcome === "acknowledged") expect(claim).toBeUndefined();
      else expect(claim).toMatchObject({ fenced: true, localSettled: true });
      expect(mockStopEnvironment.reconcile).toHaveBeenCalledTimes(
        outcome === "acknowledged" ? 1 : 0,
      );
    } finally {
      cleanup.release();
      await getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockStopEnvironment.meeting,
      )?.actual;
    }
  },
);
