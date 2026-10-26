/** @jest-environment node */
jest.mock("../../src/services/meetingUpdateService", () => ({
  updateMeeting: jest.fn(async () => ({ kind: "saved" })),
}));
import { z } from "zod";
import { updateMeeting } from "../../src/services/meetingUpdateService";
import type { ModalSubmitInteraction, ButtonInteraction } from "discord.js";
import { completedTextResponse } from "../../src/testSupport/openaiResponse";

jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/services/configService", () => ({
  config: {
    langfuse: { notesCorrectionPromptName: "synthetic" },
  },
}));
jest.mock("../../src/services/meetingHistoryService", () => ({
  getMeetingHistoryService: jest.fn(async () => ({
    guildId: "synthetic",
    channelId_timestamp: "voice#2026-01-01",
    notes: "Original",
    meetingCreatorId: "owner",
    notesVersion: 1,
    meetingName: "Manual",
    participants: [],
  })),
  updateMeetingNotesService: jest.fn(async () => true),
  updateMeetingNotesMessageMetadataService: jest.fn(async () => true),
}));
jest.mock("../../src/services/storageService", () => ({
  fetchJsonFromS3: jest.fn(),
}));
jest.mock("../../src/services/mentionRosterService", () => ({
  buildMentionRosters: jest.fn(async () => ({
    participantRoster: "",
    roles: "",
    allowedUserIds: [],
    allowedRoleIds: [],
  })),
}));
jest.mock("../../src/services/meetingSummaryService", () => ({
  generateMeetingSummaries: jest.fn(async () => ({})),
}));
jest.mock("../../src/services/meetingNameService", () => ({
  isMeetingNameAutoSynced: () => false,
  resolveMeetingNameFromSummary: jest.fn(),
}));
jest.mock("../../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename",
}));
jest.mock("../../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: () => ({ up: "up", down: "down" }),
}));
jest.mock("../../src/services/openaiClient", () => ({
  createOpenAIClient: () => ({ responses: { create: mockCreate } }),
}));
jest.mock("../../src/services/modelFactory", () => ({
  getModelChoice: () => ({ model: "synthetic" }),
  buildModelOverrides: jest.fn(),
}));
jest.mock("../../src/services/langfusePromptService", () => ({
  getLangfuseChatPrompt: async () => ({ messages: [] }),
}));
jest.mock("../../src/services/openaiModelParams", () => ({
  resolveChatParamsForRole: () => ({}),
  resolveModelParamsForContext: async () => ({}),
}));
jest.mock("../../src/services/modelChoiceService", () => ({
  resolveModelChoicesForContext: async () => ({}),
}));
const mockCreate = jest.fn(async () => completedTextResponse("Corrected"));
import {
  handleNotesCorrectionModal,
  handleNotesCorrectionAccept,
} from "../../src/commands/notesCorrections";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
function modal() {
  return {
    customId: `notes_correction_modal:${Buffer.from("voice#2026-01-01").toString("base64")}`,
    guildId: "synthetic",
    user: { id: "owner", tag: "synthetic", username: "synthetic" },
    fields: { getTextInputValue: () => "Fix" },
    deferReply: jest.fn(async () => {}),
    editReply: jest.fn(async () => {}),
  } as unknown as ModalSubmitInteraction;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => jest.clearAllMocks());
test("held correction provider cannot publish proposal after interaction fence", async () => {
  const entered = deferred<void>();
  const provider = deferred<Awaited<ReturnType<typeof mockCreate>>>();
  mockCreate.mockImplementationOnce(() => {
    entered.resolve();
    return provider.promise;
  });
  const interaction = modal();
  const controller = new AbortController();
  const run = handleNotesCorrectionModal(interaction, controller.signal);
  await entered.promise;
  controller.abort();
  provider.resolve(completedTextResponse("Late"));
  await run.catch(() => {});
  expect(interaction.editReply).not.toHaveBeenCalled();
});
test("held correction summary cannot initiate canonical update after interaction fence", async () => {
  const proposal = modal();
  await handleNotesCorrectionModal(proposal);
  const payload = jest.mocked(proposal.editReply).mock.calls[0][0];
  const token = z
    .object({
      components: z.array(
        z.object({
          components: z.array(
            z.object({ data: z.object({ custom_id: z.string() }) }),
          ),
        }),
      ),
    })
    .parse(payload).components[0].components[0].data.custom_id;
  const interaction = {
    customId: token,
    user: { id: "owner" },
    guild: { channels: { cache: new Map() } },
    deferUpdate: jest.fn(async () => {}),
    editReply: jest.fn(async () => {}),
  } as unknown as ButtonInteraction;
  const entered = deferred<void>();
  const provider =
    deferred<Awaited<ReturnType<typeof generateMeetingSummaries>>>();
  jest.mocked(generateMeetingSummaries).mockImplementationOnce(() => {
    entered.resolve();
    return provider.promise;
  });
  const controller = new AbortController();
  const run = handleNotesCorrectionAccept(interaction, controller.signal);
  await entered.promise;
  const priorReplies = jest.mocked(interaction.editReply).mock.calls.length;
  controller.abort();
  provider.resolve({});
  await run.catch(() => {});
  expect(updateMeeting).not.toHaveBeenCalled();
  expect(interaction.editReply).toHaveBeenCalledTimes(priorReplies);
});
