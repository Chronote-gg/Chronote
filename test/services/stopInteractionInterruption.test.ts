/** @jest-environment node */
import { Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import type { SessionReservation } from "../../src/types/deploymentControl";
import { setupBot } from "../../src/bot";
import { getMeetingInterruptionCheckpoints } from "../../src/services/ownedMeetingInterruption";
import {
  fenceRuntimeWorkAdmission,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
const mockReceipt = jest.fn();
const mockRepository = {
  claimCommand: jest.fn(),
  renewCommand: jest.fn(async () => true),
  failCommand: jest.fn(async () => true),
  completeCommand: jest.fn(),
};
const mockReconcile = jest.fn(async () => true);
const mockClose = jest.fn(async () => {});
const mockTerminalRead = jest.fn();
let mockMeeting: MeetingData;
let mockOwnership = new AbortController();
const mockReservations: Array<{ reservation: SessionReservation }> = [];
jest.mock("../../src/commands/startMeeting", () => ({}));
jest.mock("../../src/services/runtimeInstanceService", () => ({
  getRuntimeInstanceId: () => "synthetic-owner",
}));
jest.mock("../../src/repositories/meetingControlCommandRepository", () => ({
  getMeetingControlCommandRepository: () => mockRepository,
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  isRuntimeWarm: () => false,
  beginRuntimeWork: () => {
    throw new Error("Unexpected independent work");
  },
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => mockReservations,
  getReservationSignal: () => mockOwnership.signal,
  isReservationControlEligible: () => true,
  reconcilePreservedRecordingReservation: (...args: unknown[]) =>
    mockReconcile(...args),
}));
jest.mock("../../src/meetings", () => ({
  getMeeting: () => mockMeeting,
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: async () => true,
}));
jest.mock("../../src/audio", () => ({
  stopRecordingCapture: jest.fn(),
  closeFailedInitializationOutput: async () => true,
  closeOutputFile: () => mockClose(),
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/audio/soundCues", () => ({
  stopThinkingCueLoop: jest.fn(),
}));
jest.mock("../../src/services/recordingContentService", () => ({
  checkpointRecordingContext: jest.fn(),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  settleOwnedVoiceSession: async () => "settled",
  waitOwnedVoiceEffects: async () => {},
}));
jest.mock("../../src/db", () => ({
  tryCreateInteractionReceipt: (...args: unknown[]) => mockReceipt(...args),
  getDeploymentControlRepository: () => ({
    getMeetingHistory: () => mockTerminalRead(),
  }),
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    read: async () => ({
      missing: [],
      manifest: { captureState: { kind: "complete" } },
    }),
  }),
}));
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const capturedClient: { value?: Client } = {};
const currentBot = () => capturedClient.value!;
beforeAll(async () => {
  jest.spyOn(Client.prototype, "login").mockImplementation(async function (
    this: Client,
  ) {
    Object.assign(capturedClient, { value: this });
    return "synthetic";
  });
  await setupBot();
});
afterAll(async () => {
  await currentBot().destroy();
  jest.restoreAllMocks();
});
test.each([
  "acknowledged",
  "receipt_lost",
  "defer_lost",
  "already_deferred",
  "duplicate",
  "held_receipt",
  "held_defer",
] as const)(
  "actual end-button route preserves exact receipt/defer proof: %s",
  async (outcome) => {
    jest.clearAllMocks();
    mockOwnership = new AbortController();
    mockReservations.length = 0;
    mockReceipt.mockReset();
    if (outcome === "receipt_lost")
      mockReceipt.mockRejectedValue(new Error("Synthetic lost receipt ACK"));
    else mockReceipt.mockResolvedValue(outcome !== "duplicate");
    const acknowledgment = held();
    const entered = held();
    if (outcome === "held_receipt")
      mockReceipt.mockImplementationOnce(async () => {
        entered.release();
        await acknowledgment.promise;
        return true;
      });
    const cleanup = held();
    mockClose.mockReturnValue(cleanup.promise);
    const childSettled = jest.fn();
    const original = {
      guildId: `synthetic-button-${outcome}`,
      meetingId: "synthetic-recording",
      sessionMode: "meeting",
      ownerInstanceId: "synthetic-owner",
      executionVersion: 1,
      voiceOperationAttemptId: "synthetic-voice",
      reservedAt: 0,
      historyKey: {
        guildId: `synthetic-button-${outcome}`,
        channelId_timestamp: "voice#start",
      },
      workHandle: {
        transition: jest.fn(),
        settle: jest.fn(),
        beginOwnedControl: () => ({ settle: childSettled }),
      },
    } as unknown as SessionReservation;
    mockReservations.push({ reservation: original });
    mockTerminalRead.mockResolvedValue({
      ...original,
      status: "complete",
      checkpoint: {
        revision: 1,
        capture: { ...original, channelId_timestamp: "voice#start" },
      },
    });
    mockMeeting = {
      ...original,
      reservation: original,
      creator: { id: "synthetic-user" },
      channelId: "voice",
      voiceChannel: { id: "voice", name: "Synthetic voice" },
      startMessageId: "synthetic-control",
      startTime: new Date(0),
      setFinished: jest.fn(),
      audioData: {},
      recordingCapture: {
        finish: jest.fn(async () => {
          throw new Error("Synthetic processing failure");
        }),
        fence: jest.fn(),
        settled: async () => {},
        releaseSettledBuffers: jest.fn(),
      },
    } as unknown as MeetingData;
    const interaction = {
      id: `synthetic-interaction-${outcome}`,
      guildId: original.guildId,
      user: { id: "synthetic-user" },
      customId: "end_meeting",
      message: { id: "synthetic-control" },
      isRepliable: () => true,
      isButton: () => true,
      isChatInputCommand: () => false,
      isUserContextMenuCommand: () => false,
      isModalSubmit: () => false,
      isChannelSelectMenu: () => false,
      deferred: outcome === "already_deferred",
      replied: false,
      deferUpdate: jest.fn(async () => {
        if (outcome === "held_defer") {
          entered.release();
          await acknowledgment.promise;
        }
        if (outcome === "defer_lost")
          throw new Error("Synthetic lost defer ACK");
      }),
      followUp: jest.fn(async () => {}),
      reply: jest.fn(async () => {}),
    };
    try {
      const listener = currentBot().listeners("interactionCreate")[0] as (
        value: unknown,
      ) => Promise<void>;
      const handling = listener(interaction);
      if (outcome === "held_receipt" || outcome === "held_defer") {
        await entered.promise;
        fenceRuntimeWorkAdmission(interaction.id);
        expect(childSettled).not.toHaveBeenCalled();
        expect(
          getRuntimeWorkAdmissionCheckpoints().find(
            ({ id }) => id === interaction.id,
          )?.effects,
        ).toHaveLength(1);
        acknowledgment.release();
      }
      await handling;
      expect(interaction.followUp).not.toHaveBeenCalled();
      expect(mockReconcile).not.toHaveBeenCalled();
      cleanup.release();
      const interruption = getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockMeeting,
      );
      if (["acknowledged", "already_deferred"].includes(outcome)) {
        expect(interruption).toBeDefined();
        expect(await interruption!.actual).toEqual({
          kind: outcome === "acknowledged" ? "settled" : "unresolved",
        });
      }
      expect(childSettled).toHaveBeenCalledTimes(
        ["acknowledged", "duplicate"].includes(outcome) ? 1 : 0,
      );
      expect(
        Boolean(
          getRuntimeWorkAdmissionCheckpoints().find(
            ({ id }) => id === interaction.id,
          ),
        ),
      ).toBe(!["acknowledged", "duplicate"].includes(outcome));
    } finally {
      acknowledgment.release();
      cleanup.release();
      await getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockMeeting,
      )?.actual;
    }
  },
);
