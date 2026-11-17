/** @jest-environment node */
import { answerQuestionService } from "../../src/services/askService";
import { executeAskAgent } from "../../src/services/askAgentService";
import { config } from "../../src/services/configService";
jest.mock("../../src/services/askAgentService", () => ({
  executeAskAgent: jest.fn(),
}));
test("requires a bound acting user before retrieving any meeting data", async () => {
  await expect(
    answerQuestionService({
      guildId: "g",
      channelId: "v",
      question: "Find notes",
    }),
  ).rejects.toThrow("signed-in");
  expect(executeAskAgent).not.toHaveBeenCalled();
});
test("passes scope and explicitly selected canonical context to the same agent used by portal", async () => {
  config.mock.enabled = false;
  config.ask.agentEnabled = true;
  (executeAskAgent as jest.Mock).mockResolvedValue({
    answer: "Answer",
    citations: [],
    sourceMeetingIds: [],
    history: [],
    provenance: { evidence: [], loadedMeetings: [] },
  });
  const result = await answerQuestionService({
    guildId: "g",
    channelId: "v",
    question: "Find older decisions",
    viewerUserId: "user",
    scope: "channel",
    contextMeetingIds: ["v#2020-01-01T00:00:00.000Z"],
  });
  expect(result.answer).toBe("Answer");
  expect(executeAskAgent).toHaveBeenLastCalledWith(
    expect.objectContaining({
      principal: { userId: "user", serverIds: ["g"] },
      scope: "channel",
      channelId: "v",
      selectedMeetings: [{ serverId: "g", id: "v#2020-01-01T00:00:00.000Z" }],
    }),
  );
});
