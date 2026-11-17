import { createAskRunService, runIdentity } from "./askRunService";
import { answerQuestionService } from "./askService";
import type { AskAgentProvenance } from "./askAgentTools";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AskRunInput, AskRunScope, AskRunSnapshot } from "../types/askRun";
import { persistCompletedAskRun } from "./askConversationService";
import { config } from "./configService";

type PrivateState = { history: AgentMessage[]; provenance: AskAgentProvenance };
let runs: ReturnType<typeof createAskRunService> | undefined;
function service() {
  return (runs ??= createAskRunService({
    async execute(input) {
      const prior = input.privateState as PrivateState | undefined;
      const answer = await answerQuestionService({
        guildId: input.guildId,
        channelId: "",
        viewerUserId: input.userId,
        conversationId: input.conversationId,
        timezone: input.timezone,
        question: input.question,
        contextMeetingIds: input.contextMeetingIds,
        agentHistory: prior?.history,
        provenance: prior?.provenance,
        signal: input.signal,
        onTextDelta: input.onTextDelta,
        onToolActivity: input.onToolActivity,
      });
      return {
        result: {
          answer: answer.answer,
          citations: answer.citations,
          sourceMeetingIds: answer.sourceMeetingIds,
        },
        privateState: {
          history: answer.history,
          provenance: answer.provenance,
        },
      };
    },
  }));
}
export type AskApplicationSnapshot = Omit<AskRunSnapshot, "result"> & {
  result?: Awaited<ReturnType<typeof persistCompletedAskRun>>;
};
async function project(
  scope: AskRunScope,
  run: AskRunSnapshot,
): Promise<AskApplicationSnapshot> {
  if (run.status !== "completed" || !run.result)
    return { ...run, result: undefined };
  const sourceMeetingIds = Array.isArray(run.result.sourceMeetingIds)
    ? run.result.sourceMeetingIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const result = await persistCompletedAskRun({
    ...scope,
    requestId: run.requestId,
    question: run.question,
    createdAt: run.createdAt,
    completedAt: run.updatedAt,
    result: {
      answer: run.result.answer,
      citations: run.result.citations,
      sourceMeetingIds,
    },
  });
  return { ...run, result };
}
export async function startAskApplicationRun(input: AskRunInput) {
  if (!config.ask.agentEnabled && !config.mock.enabled)
    throw new Error("The Ask agent is not enabled yet.");
  return project(input, await service().start(input));
}
export async function getAskApplicationRun(
  input: AskRunScope & { runId: string },
) {
  return project(input, await service().get(input));
}
export async function stopAskApplicationRun(
  input: AskRunScope & { runId: string },
) {
  return project(input, await service().stop(input));
}

export async function getAskApplicationRunByRequest(
  input: AskRunScope & { requestId: string },
) {
  try {
    return await getAskApplicationRun({ ...input, runId: runIdentity(input) });
  } catch (error) {
    if (error instanceof Error && error.message === "Ask run not found")
      return null;
    throw error;
  }
}
