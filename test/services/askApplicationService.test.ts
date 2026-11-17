/** @jest-environment node */
import {
  startAskApplicationRun,
  getAskApplicationRunByRequest,
  getAskApplicationRun,
} from "../../src/services/askApplicationService";
import { answerQuestionService } from "../../src/services/askService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { config } from "../../src/services/configService";
jest.mock("../../src/services/askService", () => ({
  answerQuestionService: jest.fn(),
}));

beforeEach(() => {
  config.ask.agentEnabled = true;
  config.mock.enabled = true;
  resetMockStore();
});

test("accepted retry uses the original run and projects only the completed safe answer", async () => {
  const store = getMockStore();
  const input = {
    userId: store.user.id,
    guildId: store.userGuilds[0].id,
    conversationId: "app-run",
    requestId: "send-a",
    question: "What changed?",
  };
  (answerQuestionService as jest.Mock).mockResolvedValue({
    answer: "Notes changed.",
    citations: [],
    sourceMeetingIds: [],
    history: [{ role: "user", content: "PRIVATE_TOOL_MARKER" }],
    provenance: { evidence: [], loadedMeetings: [] },
  });
  const accepted = await startAskApplicationRun(input);
  let result = await getAskApplicationRun({ ...input, runId: accepted.runId });
  for (
    let n = 0;
    n < 20 && (result.status === "running" || result.status === "queued");
    n++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    result = await getAskApplicationRun({ ...input, runId: accepted.runId });
  }
  expect(result.status).toBe("completed");
  expect(result.result?.messages.map((m) => m.text)).toEqual([
    "What changed?",
    "Notes changed.",
  ]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_TOOL_MARKER");
  expect((await startAskApplicationRun(input)).runId).toBe(accepted.runId);
  expect(answerQuestionService).toHaveBeenCalledTimes(1);
  expect((await getAskApplicationRunByRequest(input))?.runId).toBe(
    accepted.runId,
  );
  expect(
    await getAskApplicationRunByRequest({ ...input, userId: "another-user" }),
  ).toBeNull();
});

it("projects a completed run after the browser stops reading", async () => {
  const store = getMockStore();
  const input = {
    userId: store.user.id,
    guildId: store.userGuilds[0].id,
    conversationId: "detached-app-run",
    requestId: "detached-send",
    question: "What changed while I was away?",
  };
  let complete!: (result: unknown) => void;
  (answerQuestionService as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const accepted = await startAskApplicationRun(input);
  for (let n = 0; n < 30; n++) await Promise.resolve();
  complete({
    answer: "The answer is saved.",
    citations: [],
    sourceMeetingIds: [],
    history: [],
    provenance: { evidence: [], loadedMeetings: [] },
  });
  for (let n = 0; n < 100; n++) await Promise.resolve();
  const { listAskConversations, getAskConversationWithMessages } =
    await import("../../src/services/askConversationService");
  expect(
    (await listAskConversations(input.userId, input.guildId)).map(
      (conversation) => conversation.id,
    ),
  ).toContain(input.conversationId);
  const saved = await getAskConversationWithMessages(
    input.userId,
    input.guildId,
    input.conversationId,
  );
  expect(saved?.messages.map((message) => message.text)).toEqual([
    input.question,
    "The answer is saved.",
  ]);
  const ids = saved?.messages.map((message) => message.id);
  await getAskApplicationRun({ ...input, runId: accepted.runId });
  await getAskApplicationRun({ ...input, runId: accepted.runId });
  expect(
    (
      await getAskConversationWithMessages(
        input.userId,
        input.guildId,
        input.conversationId,
      )
    )?.messages.map((message) => message.id),
  ).toEqual(ids);
});
