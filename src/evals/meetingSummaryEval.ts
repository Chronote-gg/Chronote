import { z } from "zod";
import {
  generateMeetingSummaries,
  type MeetingSummaries,
} from "../services/meetingSummaryService";
import {
  getLangfuseClient,
  isLangfuseEnabled,
} from "../services/langfuseClient";
import { getEvalDataset } from "./evalDataset";

const EvalInputSchema = z.object({
  notes: z.string(),
  serverName: z.string(),
  channelName: z.string(),
  tags: z.array(z.string()).optional(),
  previousSummarySentence: z.string().optional(),
  previousSummaryLabel: z.string().optional(),
});

const ExpectedOutputSchema = z
  .object({
    summarySentence: z.string().optional(),
    summaryLabel: z.string().optional(),
  })
  .optional();

function normalize(value?: string) {
  return value?.trim().toLowerCase() ?? "";
}

async function run() {
  if (!isLangfuseEnabled()) {
    throw new Error("Langfuse keys are required to run evals.");
  }

  const datasetName = process.env.LANGFUSE_EVAL_DATASET || "meeting-summary";
  const experimentName =
    process.env.LANGFUSE_EVAL_EXPERIMENT ||
    `meeting-summary-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const langfuse = getLangfuseClient();
  if (!langfuse) {
    throw new Error("Langfuse client is unavailable.");
  }

  const dataset = await getEvalDataset(langfuse, datasetName);

  const result = await dataset.runExperiment({
    name: experimentName,
    task: async (item) => {
      const input = EvalInputSchema.parse(item.input);
      return await generateMeetingSummaries({
        ...input,
        now: new Date(),
      });
    },
    evaluators: [
      async ({ output, expectedOutput }) => {
        const expected = ExpectedOutputSchema.parse(expectedOutput);
        const summaries = output as MeetingSummaries;
        const evaluations = [
          {
            name: "summary_sentence_present",
            value: summaries.summarySentence ? 1 : 0,
          },
          {
            name: "summary_label_present",
            value: summaries.summaryLabel ? 1 : 0,
          },
        ];

        if (expected?.summarySentence) {
          evaluations.push({
            name: "summary_sentence_exact",
            value:
              normalize(summaries.summarySentence) ===
              normalize(expected.summarySentence)
                ? 1
                : 0,
          });
        }
        if (expected?.summaryLabel) {
          evaluations.push({
            name: "summary_label_exact",
            value:
              normalize(summaries.summaryLabel) ===
              normalize(expected.summaryLabel)
                ? 1
                : 0,
          });
        }
        return evaluations;
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
