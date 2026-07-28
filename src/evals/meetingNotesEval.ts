import { z } from "zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { config } from "../services/configService";
import { getLangfuseChatPrompt } from "../services/langfusePromptService";
import {
  getLangfuseClient,
  isLangfuseEnabled,
} from "../services/langfuseClient";
import { getModelChoice } from "../services/modelFactory";
import { createOpenAIClient } from "../services/openaiClient";
import { resolveChatParamsForRole } from "../services/openaiModelParams";
import { gradeMentions } from "./roleMentionGraders";

/**
 * Notes eval cases carry rendered prompt variables rather than a MeetingData
 * object, so a case can be curated by hand or harvested from a downvoted
 * meeting without reconstructing Discord state.
 */
const EvalInputSchema = z.object({
  transcript: z.string(),
  participantRoster: z.string(),
  roles: z.string(),
  serverName: z.string().default("Server X"),
  serverDescription: z.string().default(""),
  voiceChannelName: z.string().default("Channel Y"),
  attendees: z.string().default(""),
  events: z.string().default(""),
  channelNames: z.string().default(""),
  formattedContext: z.string().default(""),
  botDisplayName: z.string().default("Chronote"),
  chatContextInstruction: z
    .string()
    .default(
      "No additional participant chat was captured; rely on transcript and provided context.",
    ),
  chatContextBlock: z.string().default(""),
  allowedUserIds: z.array(z.string()).default([]),
  allowedRoleIds: z.array(z.string()).default([]),
  guildId: z.string().optional(),
});

const ExpectedOutputSchema = z
  .object({
    expectedUserIds: z.array(z.string()).optional(),
    expectedRoleIds: z.array(z.string()).optional(),
  })
  .optional();

type EvalInput = z.infer<typeof EvalInputSchema>;

const generateNotesForEval = async (input: EvalInput): Promise<string> => {
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.notesPromptName,
    variables: {
      formattedContext: input.formattedContext,
      botDisplayName: input.botDisplayName,
      chatContextInstruction: input.chatContextInstruction,
      chatContextBlock: input.chatContextBlock,
      participantRoster: input.participantRoster,
      serverName: input.serverName,
      serverDescription: input.serverDescription,
      voiceChannelName: input.voiceChannelName,
      attendees: input.attendees,
      roles: input.roles,
      events: input.events,
      channelNames: input.channelNames,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      transcript: input.transcript,
    },
  });

  const { model } = getModelChoice("notes");
  const modelParams = resolveChatParamsForRole({ role: "notes", model });
  const openAIClient = createOpenAIClient({
    traceName: "meeting-notes-eval",
    generationName: "meeting-notes-eval",
    tags: ["feature:notes", "eval"],
    langfusePrompt,
  });
  const completion = await openAIClient.chat.completions.create({
    model,
    messages: messages as ChatCompletionMessageParam[],
    ...modelParams,
  });

  return completion.choices[0]?.message?.content ?? "";
};

async function run() {
  if (!isLangfuseEnabled()) {
    throw new Error("Langfuse keys are required to run evals.");
  }

  const datasetName = process.env.LANGFUSE_EVAL_DATASET || "meeting-notes";
  const experimentName =
    process.env.LANGFUSE_EVAL_EXPERIMENT ||
    `meeting-notes-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const langfuse = getLangfuseClient();
  if (!langfuse) {
    throw new Error("Langfuse client is unavailable.");
  }

  const dataset = await langfuse.dataset.get(datasetName);

  const result = await dataset.runExperiment({
    name: experimentName,
    task: async (item) =>
      generateNotesForEval(EvalInputSchema.parse(item.input)),
    evaluators: [
      async ({ input, output, expectedOutput }) => {
        const parsedInput = EvalInputSchema.parse(input);
        const expected = ExpectedOutputSchema.parse(expectedOutput);
        const notes = typeof output === "string" ? output : "";
        return [
          { name: "notes_present", value: notes.trim() ? 1 : 0 },
          ...gradeMentions({
            notes,
            allowedUserIds: parsedInput.allowedUserIds,
            allowedRoleIds: parsedInput.allowedRoleIds,
            guildId: parsedInput.guildId,
            expectedUserIds: expected?.expectedUserIds,
            expectedRoleIds: expected?.expectedRoleIds,
          }),
        ];
      },
    ],
  });

  console.log(await result.format());
  await langfuse.shutdown();
}

run().catch((error) => {
  console.error("Eval run failed:", error);
  process.exit(1);
});
