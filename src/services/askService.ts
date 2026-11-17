import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AskCitation } from "../types/ask";
import type { AskAgentProvenance } from "./askAgentTools";
import { executeAskAgent } from "./askAgentService";
import { captureEvent } from "./analyticsService";
import { config } from "./configService";
import { answerLegacyAskQuestion } from "./legacyAskService";

export type AskScope = "guild" | "channel";
export interface AskRequest {
  guildId: string;
  channelId: string;
  question: string;
  viewerUserId?: string;
  scope?: AskScope;
  tags?: string[];
  contextMeetingIds?: string[];
  history?: { role: "user" | "chronote"; text: string }[];
  agentHistory?: AgentMessage[];
  provenance?: AskAgentProvenance;
  timezone?: string;
  conversationId?: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onToolActivity?: (tool: string) => void;
}
export interface AskResponse {
  answer: string;
  sourceMeetingIds?: string[];
  citations?: AskCitation[];
  history?: AgentMessage[];
  provenance?: AskAgentProvenance;
}
/** Both portal runs and Discord use this identity-bound entry point. */
export async function answerQuestionService(
  req: AskRequest,
): Promise<AskResponse> {
  if (!req.viewerUserId) throw new Error("Ask requires a signed-in user.");
  if (!req.question.trim()) throw new Error("Ask requires a question.");
  if (req.scope === "channel" && !req.channelId)
    throw new Error("Channel scope requires a channel.");
  req.signal?.throwIfAborted();
  captureEvent("ask_question_asked", {
    userId: req.viewerUserId,
    guildId: req.guildId,
    properties: {
      scope: req.scope ?? "guild",
      has_tag_filter: Boolean(req.tags?.length),
      question_length: req.question.length,
    },
  });
  if (config.mock.enabled)
    return {
      answer: `Mock answer for "${req.question}".`,
      citations: [],
      sourceMeetingIds: [],
    };
  if (!config.ask.agentEnabled) return answerLegacyAskQuestion(req);
  return executeAskAgent({
    principal: { userId: req.viewerUserId, serverIds: [req.guildId] },
    question: req.question,
    guildId: req.guildId,
    channelId: req.channelId,
    scope: req.scope,
    tags: req.tags,
    conversationId: req.conversationId,
    timezone: req.timezone,
    selectedMeetings: req.contextMeetingIds?.map((id) => ({
      serverId: req.guildId,
      id,
    })),
    // Legacy answers have no source provenance. Reconstruct context through tools instead.
    history: req.agentHistory,
    provenance: req.provenance,
    signal: req.signal,
    onTextDelta: req.onTextDelta,
    onToolActivity: req.onToolActivity,
  });
}
