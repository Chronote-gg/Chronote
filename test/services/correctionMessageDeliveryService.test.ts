/** @jest-environment node */
import "../deployment/coldNetworkGuard.cjs";
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import { publishCorrectionMessages } from "../../src/services/correctionMessageDeliveryService";
import * as histories from "../../src/repositories/meetingHistoryRepository";
import {
  createDiscordMessage,
  deleteDiscordMessage,
} from "../../src/services/discordMessageService";
import {
  fenceRuntimeWorkAdmissions,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
const mockSettled = jest.fn();
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ transition: jest.fn(), settle: mockSettled }),
  getRuntimeAdmissionContext: async () => ({ instanceId: "correction-ack" }),
}));
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => ({
    checkAdmission: async () => ({ kind: "admitted" }),
  }),
}));
jest.mock("../../src/services/discordMessageService", () => ({
  createDiscordMessage: jest.fn(),
  deleteDiscordMessage: jest.fn(),
}));
afterEach(() => jest.restoreAllMocks());

test.each(["saved", "false", "throw"])(
  "final Discord create ACK then fence persists metadata or retains unresolved owner: %s",
  async (receipt) => {
    let release!: (message: { id: string }) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.mocked(createDiscordMessage).mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const repository = histories.getMeetingHistoryRepository();
    const write = jest.fn(async () => {
      if (receipt === "throw") throw new Error("Synthetic metadata write lost");
      return receipt === "saved";
    });
    jest
      .spyOn(histories, "getMeetingHistoryRepository")
      .mockReturnValue({ ...repository, updateNotesMessageMetadata: write });
    const previous = new Set(
      getRuntimeWorkAdmissionCheckpoints().map(({ id }) => id),
    );
    const task = runRuntimeApiOperation(
      `correction-ack-${receipt}`,
      async (operation) => {
        await publishCorrectionMessages({
          operation,
          guildId: "synthetic-guild",
          historyKey: "synthetic#key",
          channelId: "synthetic-text",
          notesVersion: 2,
          publish: async () => {
            const message = await operation.mutate(() =>
              createDiscordMessage("synthetic-text", {
                content: "synthetic notes",
              }),
            );
            return { messageIds: [message.id], strategy: "replaced" };
          },
        });
        await operation.mutate(() =>
          deleteDiscordMessage("synthetic-text", "old-id"),
        );
      },
    ).catch((error: unknown) => error);
    await started;
    fenceRuntimeWorkAdmissions();
    release({ id: "acknowledged-message" });
    await task;
    expect(write).toHaveBeenCalledWith({
      guildId: "synthetic-guild",
      channelId_timestamp: "synthetic#key",
      notesMessageIds: ["acknowledged-message"],
      notesChannelId: "synthetic-text",
      expectedNotesVersion: 2,
    });
    expect(deleteDiscordMessage).not.toHaveBeenCalled();
    const retained = getRuntimeWorkAdmissionCheckpoints().filter(
      ({ id }) => !previous.has(id),
    );
    expect(retained).toHaveLength(receipt === "saved" ? 0 : 1);
  },
);
