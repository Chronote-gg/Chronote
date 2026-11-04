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
const refuseIndependentWork = (): { settle: () => void } => {
  throw new Error("Unexpected independent work");
};
let independentWork = refuseIndependentWork;
const noActiveLease = async (): Promise<
  { leaseExpiresAt: number } | undefined
> => undefined;
let activeLease = noActiveLease;
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  isRuntimeWarm: () => false,
  beginRuntimeWork: () => independentWork(),
}));
jest.mock("../../src/db", () => ({
  tryCreateInteractionReceipt: (...args: unknown[]) =>
    mockStopEnvironment.receipt(...args),
  getActiveMeetingLease: () => activeLease(),
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
    Object.defineProperty(this, "user", { value: { id: "synthetic-bot" } });
    return "synthetic";
  });
  await setupBot();
});
afterAll(async () => {
  await currentBot().destroy();
  jest.restoreAllMocks();
});
describe.each(["button", "leave", "context"] as const)(
  "%s stop route",
  (route) => {
    test.each([
      "acknowledged",
      "receipt_lost",
      "defer_lost",
      "already_deferred",
      "duplicate",
      "held_receipt",
      "held_defer",
    ] as const)("preserves exact receipt/defer proof: %s", async (outcome) => {
      jest.clearAllMocks();
      mockStopEnvironment.ownership = new AbortController();
      mockStopEnvironment.reservations.length = 0;
      mockStopEnvironment.receipt.mockReset();
      if (outcome === "receipt_lost")
        mockStopEnvironment.receipt.mockRejectedValue(
          new Error("Synthetic lost receipt ACK"),
        );
      else
        mockStopEnvironment.receipt.mockResolvedValue(outcome !== "duplicate");
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
        `synthetic-${route}-${outcome}`,
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
      let deferred = outcome === "already_deferred";
      const defer = jest.fn(async () => {
        if (outcome === "already_deferred")
          throw new Error("Interaction already acknowledged");
        if (outcome === "held_defer") {
          entered.release();
          await acknowledgment.promise;
        }
        if (outcome === "defer_lost")
          throw new Error("Synthetic lost defer ACK");
        deferred = true;
      });
      const interaction = {
        id: `synthetic-interaction-${route}-${outcome}`,
        guildId: original.guildId,
        guild: { members: { fetch: async () => null } },
        user: { id: "synthetic-user" },
        targetUser: { id: "synthetic-bot" },
        commandName: route === "leave" ? "leave" : "Stop recording",
        options: { getBoolean: () => true },
        customId: "end_meeting",
        message: { id: "synthetic-control" },
        inGuild: () => true,
        isRepliable: () => true,
        isButton: () => route === "button",
        isChatInputCommand: () => route === "leave",
        isUserContextMenuCommand: () => route === "context",
        isModalSubmit: () => false,
        isChannelSelectMenu: () => false,
        get deferred() {
          return deferred;
        },
        replied: false,
        deferUpdate: defer,
        deferReply: defer,
        editReply: jest.fn(async () => {}),
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
        // A stop that cannot settle must still tell the user something.
        expect(
          interaction.reply.mock.calls.length +
            interaction.editReply.mock.calls.length +
            interaction.followUp.mock.calls.length,
        ).toBe(outcome === "duplicate" ? 0 : 1);
        // A deferred update's editReply would overwrite the control message
        // the whole channel sees, so that notice has to follow up instead.
        const deferredUpdate =
          route === "button" && deferred && outcome !== "already_deferred";
        expect(interaction.followUp.mock.calls.length).toBe(
          deferredUpdate ? 1 : 0,
        );
        expect(mockStopEnvironment.reconcile).not.toHaveBeenCalled();
        cleanup.release();
        const interruption = getMeetingInterruptionCheckpoints().find(
          ({ meeting }) => meeting === mockStopEnvironment.meeting,
        );
        expect(Boolean(interruption)).toBe(
          outcome === "acknowledged" ||
            (route === "button" && outcome === "already_deferred"),
        );
        if (interruption) {
          expect(await interruption.actual).toEqual({
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
    });
  },
);

test("delivers nothing while another runtime owns the meeting", async () => {
  jest.clearAllMocks();
  // No local reservation plus an unexpired durable lease is a foreign owner.
  mockStopEnvironment.reservations.length = 0;
  activeLease = async () => ({
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 60,
  });
  independentWork = () => ({ settle: () => {} });
  const logged = jest.spyOn(console, "log").mockImplementation(() => {});
  const interaction = {
    id: "synthetic-foreign-owned",
    guildId: "synthetic-foreign-guild",
    user: { id: "synthetic-user" },
    customId: "end_meeting",
    isRepliable: () => true,
    isButton: () => true,
    isChatInputCommand: () => false,
    isUserContextMenuCommand: () => false,
    deferred: false,
    replied: false,
    deferUpdate: jest.fn(async () => {}),
    editReply: jest.fn(async () => {}),
    followUp: jest.fn(async () => {}),
    reply: jest.fn(async () => {}),
  };
  try {
    const listener = currentBot().listeners("interactionCreate")[0] as (
      value: unknown,
    ) => Promise<void>;
    await listener(interaction);
    // Any acknowledgement here makes the owner's defer fail, losing the stop.
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    // A silent drop with no trace is what made the original defect invisible.
    expect(logged).toHaveBeenCalledWith("Skipping foreign-owned interaction", {
      interactionId: interaction.id,
      interactionKind: "button:end_meeting",
    });
  } finally {
    logged.mockRestore();
    activeLease = noActiveLease;
    independentWork = refuseIndependentWork;
  }
});
