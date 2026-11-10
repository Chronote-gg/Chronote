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
  beginRuntimeWorkClaim,
  fenceAndSettleSessionWork,
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
const interactionListener = () =>
  currentBot().listeners("interactionCreate")[0] as (
    value: unknown,
  ) => Promise<void>;
const interactionResponseSpies = () => ({
  editReply: jest.fn(async () => {}),
  followUp: jest.fn(async () => {}),
  reply: jest.fn(async () => {}),
});
const closingInteraction = (id: string, guildId: string) => ({
  id,
  guildId,
  createdTimestamp: Date.now(),
  commandName: "leave",
  isRepliable: () => true,
  isButton: () => false,
  isChatInputCommand: () => true,
  isUserContextMenuCommand: () => false,
  ...interactionResponseSpies(),
});
const resetClosingSession = () => {
  jest.clearAllMocks();
  mockStopEnvironment.ownership = new AbortController();
  mockStopEnvironment.reservations.length = 0;
  mockStopEnvironment.receipt.mockResolvedValue(true);
};
const stopRoutes = ["button", "leave", "context"] as const;
const stopOutcomes = [
  "acknowledged",
  "receipt_lost",
  "defer_lost",
  "already_deferred",
  "duplicate",
  "held_receipt",
  "held_defer",
] as const;
/**
 * A stop that cannot settle must still tell the user exactly one thing, and a
 * deferred update's `editReply` would overwrite the control message the whole
 * channel sees, so on that route the one notice has to follow up instead.
 */
const expectedNotices = (
  route: (typeof stopRoutes)[number],
  outcome: (typeof stopOutcomes)[number],
  deferred: boolean,
): { total: number; followUp: number } => {
  const deferredUpdate =
    route === "button" && deferred && outcome !== "already_deferred";
  return {
    total: outcome === "duplicate" ? 0 : 1,
    followUp: deferredUpdate ? 1 : 0,
  };
};
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
describe.each(stopRoutes)("%s stop route", (route) => {
  test.each(stopOutcomes)(
    "preserves exact receipt/defer proof: %s",
    async (outcome) => {
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
        ...interactionResponseSpies(),
      };
      try {
        const handling = interactionListener()(interaction);
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
        const notices = expectedNotices(route, outcome, deferred);
        expect(
          interaction.reply.mock.calls.length +
            interaction.editReply.mock.calls.length +
            interaction.followUp.mock.calls.length,
        ).toBe(notices.total);
        expect(interaction.followUp.mock.calls.length).toBe(notices.followUp);
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
    },
  );
});

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
    ...interactionResponseSpies(),
  };
  try {
    await interactionListener()(interaction);
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

test.each(["closing", "aborted", "duplicate", "receipt_lost", "reply_lost"])(
  "answers leave for a %s local session without reopening its stop",
  async (outcome) => {
    resetClosingSession();
    if (outcome === "duplicate")
      mockStopEnvironment.receipt.mockResolvedValue(false);
    if (outcome === "receipt_lost")
      mockStopEnvironment.receipt.mockRejectedValue(
        new Error("Synthetic receipt unavailable"),
      );
    const { original, childSettled } = stoppedRecordingFixture(
      `synthetic-closing-leave-${outcome}`,
    );
    await fenceAndSettleSessionWork(original);
    if (outcome === "aborted") mockStopEnvironment.ownership.abort();
    const interaction = closingInteraction(
      `synthetic-closing-leave-interaction-${outcome}`,
      original.guildId,
    );
    if (outcome === "reply_lost")
      interaction.reply.mockRejectedValue(
        new Error("Synthetic reply unavailable"),
      );

    await interactionListener()(interaction);

    if (!["duplicate", "receipt_lost"].includes(outcome))
      expect(interaction.reply).toHaveBeenCalledWith({
        content: expect.stringMatching(/already finishing/i),
        ephemeral: true,
      });
    else expect(interaction.reply).not.toHaveBeenCalled();
    expect(original.workHandle.settle).not.toHaveBeenCalled();
    expect(mockStopEnvironment.reconcile).not.toHaveBeenCalled();
    expect(childSettled).toHaveBeenCalledTimes(
      ["receipt_lost", "reply_lost"].includes(outcome) ? 0 : 1,
    );
    expect(mockStopEnvironment.receipt).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      {
        kind: "session",
        ownership: expect.objectContaining({
          guildId: original.guildId,
          voiceOperationAttemptId: original.voiceOperationAttemptId,
        }),
        now: expect.any(Number),
      },
    );
  },
);

test.each(["receipt", "reply"])(
  "closing response retains actual held %s work after its deadline",
  async (stage) => {
    jest.useFakeTimers();
    const pending = held();
    const entered = held();
    try {
      resetClosingSession();
      const { original, childSettled } = stoppedRecordingFixture(
        `synthetic-held-${stage}`,
      );
      await fenceAndSettleSessionWork(original);
      const interaction = closingInteraction(
        `synthetic-held-response-${stage}`,
        original.guildId,
      );
      if (stage === "receipt")
        mockStopEnvironment.receipt.mockImplementationOnce(async () => {
          entered.release();
          await pending.promise;
          return true;
        });
      else
        interaction.reply.mockImplementationOnce(async () => {
          entered.release();
          await pending.promise;
        });
      const handling = interactionListener()(interaction);
      await entered.promise;
      mockStopEnvironment.ownership.abort();
      await jest.advanceTimersByTimeAsync(2501);
      expect(childSettled).not.toHaveBeenCalled();
      expect(
        getRuntimeWorkAdmissionCheckpoints().find(
          ({ id }) => id === interaction.id,
        ),
      ).toMatchObject({ localSettled: false, fenced: true });
      pending.release();
      await handling;
      expect(interaction.reply).toHaveBeenCalledTimes(
        stage === "receipt" ? 0 : 1,
      );
      expect(childSettled).toHaveBeenCalledTimes(1);
      expect(original.workHandle.settle).not.toHaveBeenCalled();
    } finally {
      pending.release();
      jest.useRealTimers();
    }
  },
);

test("response-only admission refuses a replaced original reservation", () => {
  mockStopEnvironment.reservations.length = 0;
  mockStopEnvironment.ownership = new AbortController();
  const { original } = stoppedRecordingFixture("synthetic-replaced-original");
  mockStopEnvironment.reservations[0] = {
    reservation: {
      ...original,
      voiceOperationAttemptId: "replacement-attempt",
    },
  };
  expect(() =>
    beginRuntimeWorkClaim(
      "interaction_response",
      "synthetic-stale-original",
      original,
    ),
  ).toThrow("original local session");
  expect(() =>
    beginRuntimeWorkClaim("interaction_response", "synthetic-no-original"),
  ).toThrow("original local session");
});

test.each(["overdue", "declined"])(
  "%s receipt completion releases response ownership without starting a reply",
  async (outcome) => {
    jest.useFakeTimers();
    const pending = held();
    const entered = held();
    try {
      resetClosingSession();
      const { original, childSettled } = stoppedRecordingFixture(
        `synthetic-${outcome}-receipt`,
      );
      await fenceAndSettleSessionWork(original);
      mockStopEnvironment.receipt.mockImplementationOnce(async () => {
        entered.release();
        await pending.promise;
        return outcome !== "declined";
      });
      const interaction = closingInteraction(
        `synthetic-${outcome}-receipt-interaction`,
        original.guildId,
      );
      const handling = interactionListener()(interaction);
      await entered.promise;
      if (outcome === "declined") await jest.advanceTimersByTimeAsync(2501);
      else jest.setSystemTime(Date.now() + 2501);
      expect(childSettled).not.toHaveBeenCalled();
      pending.release();
      await handling;
      expect(interaction.reply).not.toHaveBeenCalled();
      expect(childSettled).toHaveBeenCalledTimes(1);
      expect(
        getRuntimeWorkAdmissionCheckpoints().find(
          ({ id }) => id === interaction.id,
        ),
      ).toBeUndefined();
    } finally {
      pending.release();
      jest.useRealTimers();
    }
  },
);

test("fencing before receipt invocation releases response ownership without I/O", async () => {
  resetClosingSession();
  const { original, childSettled } = stoppedRecordingFixture(
    "synthetic-before-receipt",
  );
  await fenceAndSettleSessionWork(original);
  const interaction = closingInteraction(
    "synthetic-before-receipt-interaction",
    original.guildId,
  );
  const handling = interactionListener()(interaction);
  fenceRuntimeWorkAdmission(interaction.id);
  await handling;
  expect(mockStopEnvironment.receipt).not.toHaveBeenCalled();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(childSettled).toHaveBeenCalledTimes(1);
  expect(original.workHandle.settle).not.toHaveBeenCalled();
  expect(
    getRuntimeWorkAdmissionCheckpoints().find(
      ({ id }) => id === interaction.id,
    ),
  ).toBeUndefined();
});
