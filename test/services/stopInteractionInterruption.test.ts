/** @jest-environment node */
import {
  mockStopEnvironment,
  deferredStopEffect as held,
  stoppedRecordingFixture,
} from "../fixtures/stopInterruptionEnvironment";
import { Client } from "discord.js";
import type { MeetingData } from "../../src/types/meeting-data";
import { setupBot } from "../../src/bot";
import { getMeetingInterruptionCheckpoints } from "../../src/services/ownedMeetingInterruption";
import {
  fenceRuntimeWorkAdmission,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  isRuntimeWarm: () => false,
  beginRuntimeWork: () => {
    throw new Error("Unexpected independent work");
  },
}));
jest.mock("../../src/db", () => ({
  tryCreateInteractionReceipt: (...args: unknown[]) =>
    mockStopEnvironment.receipt(...args),
  getDeploymentControlRepository: () => ({
    getMeetingHistory: () => mockStopEnvironment.terminalRead(),
  }),
}));
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
    mockStopEnvironment.ownership = new AbortController();
    mockStopEnvironment.reservations.length = 0;
    mockStopEnvironment.receipt.mockReset();
    if (outcome === "receipt_lost")
      mockStopEnvironment.receipt.mockRejectedValue(
        new Error("Synthetic lost receipt ACK"),
      );
    else mockStopEnvironment.receipt.mockResolvedValue(outcome !== "duplicate");
    const acknowledgment = held();
    const entered = held();
    if (outcome === "held_receipt")
      mockStopEnvironment.receipt.mockImplementationOnce(async () => {
        entered.release();
        await acknowledgment.promise;
        return true;
      });
    const cleanup = held();
    mockStopEnvironment.close.mockReturnValue(cleanup.promise);
    const { original, childSettled } = stoppedRecordingFixture(
      `synthetic-button-${outcome}`,
    );
    mockStopEnvironment.meeting = {
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
      expect(mockStopEnvironment.reconcile).not.toHaveBeenCalled();
      cleanup.release();
      const interruption = getMeetingInterruptionCheckpoints().find(
        ({ meeting }) => meeting === mockStopEnvironment.meeting,
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
        ({ meeting }) => meeting === mockStopEnvironment.meeting,
      )?.actual;
    }
  },
);
