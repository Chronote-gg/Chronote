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

test("accepted retry uses the original run and projects only the completed safe answer", async () => {
  config.ask.agentEnabled = true;
  config.mock.enabled = true;
  resetMockStore();
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
