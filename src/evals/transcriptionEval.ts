import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import matter from "gray-matter";
import { distance as levenshteinDistance } from "fastest-levenshtein";
import {
  BedrockDataAutomationRuntimeClient,
  GetDataAutomationStatusCommand,
  InvokeDataAutomationAsyncCommand,
  type GetDataAutomationStatusCommandOutput,
} from "@aws-sdk/client-bedrock-data-automation-runtime";
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { TranscriptionCreateParamsNonStreaming } from "openai/resources/audio";
import { createOpenAIClient } from "../services/openaiClient";
import { getModelChoice } from "../services/modelFactory";
import { config } from "../services/configService";
import { TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD } from "../constants";
import {
  getLangfuseClient,
  isLangfuseEnabled,
} from "../services/langfuseClient";
import { getTranscriptionTextQuality } from "../utils/transcriptionText";

type ProviderName = "openai" | "bedrock";

type EvalOptions = {
  file?: string;
  runs: number;
  model: string;
  language: string;
  temperature?: number;
  prompt?: string;
  promptFile?: string;
  glossaryFile?: string;
  delayMs: number;
  trace: boolean;
  dropPromptLike: boolean;
  output?: string;
  quiet: boolean;
  reference?: string;
  referenceFile?: string;
  provider: ProviderName;
  langfuseDataset?: string;
  langfuseExperiment?: string;
  useDataset: boolean;
  compareNoPrompt: boolean;
};

type EvalResult = {
  run: number;
  text: string;
  promptLike: boolean;
  trivialText: boolean;
  durationMs: number;
};

type DistributionEntry = {
  text: string;
  count: number;
};

type EvalOutput = {
  text: string;
  runs: number;
  promptLikeCount: number;
  trivialTextCount: number;
  uniqueOutputs: number;
  distribution: DistributionEntry[];
  results: EvalResult[];
  topStability: number;
  avgDurationMs: number;
};

type EvalComparisonOutput = {
  withPrompt: EvalOutput;
  withoutPrompt: EvalOutput;
};

type PromptChatMessage = {
  role?: string;
  content?: string;
};

type PromptFrontMatter = {
  type?: string;
  messages?: PromptChatMessage[];
  prompt?: PromptChatMessage[];
};

type BedrockEvalConfig = {
  dataAutomationProfileArn: string;
  dataAutomationProjectArn: string;
  inputBucket: string;
  outputBucket: string;
  inputPrefix: string;
  outputPrefix: string;
  pollIntervalMs: number;
  timeoutMs: number;
};

type PromptInputs = {
  prompt?: string;
  promptFile?: string;
  glossaryFile?: string;
};

type ReferenceInputs = {
  reference?: string;
  referenceFile?: string;
};

type BatchInputs = {
  transcribeOnce: () => Promise<string>;
  runs: number;
  prompt: string;
  glossary: string;
  delayMs: number;
  dropPromptLike: boolean;
  quiet: boolean;
};

const DatasetInputSchema = z.object({
  file: z.string(),
  runs: z.number().optional(),
  language: z.string().optional(),
  temperature: z.number().optional(),
  prompt: z.string().optional(),
  promptFile: z.string().optional(),
  glossaryFile: z.string().optional(),
});

const DatasetExpectedSchema = z
  .object({
    transcript: z.string().optional(),
  })
  .optional();

const EvalOutputSchema = z.object({
  text: z.string(),
  runs: z.number(),
  promptLikeCount: z.number(),
  uniqueOutputs: z.number(),
  distribution: z.array(
    z.object({
      text: z.string(),
      count: z.number(),
    }),
  ),
  results: z.array(
    z.object({
      run: z.number(),
      text: z.string(),
      promptLike: z.boolean(),
      trivialText: z.boolean(),
      durationMs: z.number(),
    }),
  ),
  trivialTextCount: z.number(),
  topStability: z.number(),
  avgDurationMs: z.number(),
});

const BdaAudioSegmentSchema = z.object({
  type: z.string().optional(),
  text: z.string().optional(),
  start_timestamp_millis: z.number().optional(),
});

const BdaOutputSchema = z.object({
  audio_segments: z.array(BdaAudioSegmentSchema).optional(),
});

const HELP_TEXT = `
Usage:
  yarn eval:transcription --file <path> [options]

Options:
  --file, -f                Audio file to transcribe (required unless dataset)
  --runs                    Number of runs (default 5)
  --model                   Transcription model (default from config)
  --language                Language code (default en)
  --temperature             Temperature override
  --prompt                  Inline prompt text
  --prompt-file             Path to prompt file (plain text or Langfuse chat prompt)
  --glossary-file           Path to glossary file (used for prompt-like checks)
  --reference               Reference transcript text (for WER)
  --reference-file          Path to reference transcript file
  --delay-ms                Delay between runs in milliseconds
  --drop-prompt-like        Drop outputs that look like prompt leakage
  --compare-no-prompt       Run the same eval twice, once with prompt and once without prompt
  --output                  Write JSON results to a file
  --quiet                   Suppress per-run logs
  --trace                   Enable Langfuse OpenAI tracing
  --provider                Transcription provider (openai | bedrock)
  --dataset, --langfuse-dataset   Run against a Langfuse dataset
  --experiment, --langfuse-experiment  Langfuse experiment name
  --help, -h                Show this help
`;

function readFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

async function readOptionalFile(value?: string): Promise<string | undefined> {
  if (!value) return undefined;
  const resolved = path.resolve(process.cwd(), value);
  return fs.readFile(resolved, "utf8");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractChatPrompt(messages: PromptChatMessage[]): string {
  const normalized = messages
    .map((message) => ({
      role: (message.role ?? "").toLowerCase(),
      content: message.content?.trim() ?? "",
    }))
    .filter((message) => message.content.length > 0);

  const systemMessages = normalized.filter(
    (message) => message.role === "system",
  );
  const selected = systemMessages.length > 0 ? systemMessages : normalized;
  return selected.map((message) => message.content).join("\n\n");
}

async function readPromptFileContent(
  value?: string,
): Promise<string | undefined> {
  if (!value) return undefined;
  const resolved = path.resolve(process.cwd(), value);
  const raw = await fs.readFile(resolved, "utf8");
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return raw.trim();
  }
  const parsed = matter(raw);
  const data = parsed.data as PromptFrontMatter;
  if (data.type === "chat") {
    const messages = data.messages ?? data.prompt;
    if (!Array.isArray(messages) || messages.length === 0) {
      return "";
    }
    return extractChatPrompt(messages);
  }
  return parsed.content.trim();
}

function normalizeForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const cleaned = normalizeForCompare(value);
  return cleaned.length === 0 ? [] : cleaned.split(" ");
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stripLeadingSlash(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function buildS3Uri(bucket: string, key: string): string {
  return `s3://${bucket}/${stripLeadingSlash(key)}`;
}

function parseS3Uri(uri: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) {
    throw new Error(`Invalid S3 URI: ${uri}`);
  }
  return { bucket: match[1], key: decodeURIComponent(match[2]) };
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function wordErrorRate(reference: string, hypothesis: string): number | null {
  const referenceTokens = tokenize(reference);
  if (referenceTokens.length === 0) return null;
  const hypothesisTokens = tokenize(hypothesis);
  const prevRow = new Array(hypothesisTokens.length + 1).fill(0);

  for (let i = 0; i <= hypothesisTokens.length; i += 1) {
    prevRow[i] = i;
  }

  for (let i = 1; i <= referenceTokens.length; i += 1) {
    const currentRow = new Array(hypothesisTokens.length + 1);
    currentRow[0] = i;
    for (let j = 1; j <= hypothesisTokens.length; j += 1) {
      const cost = referenceTokens[i - 1] === hypothesisTokens[j - 1] ? 0 : 1;
      const deletion = prevRow[j] + 1;
      const insertion = currentRow[j - 1] + 1;
      const substitution = prevRow[j - 1] + cost;
      currentRow[j] = Math.min(deletion, insertion, substitution);
    }
    for (let j = 0; j <= hypothesisTokens.length; j += 1) {
      prevRow[j] = currentRow[j];
    }
  }

  const distance = prevRow[hypothesisTokens.length];
  return distance / referenceTokens.length;
}

function isTranscriptionLikelyPrompt(
  transcription: string,
  fullPrompt: string,
  glossaryContent: string,
): boolean {
  const normalizedTranscription = transcription.trim().toLowerCase();
  const normalizedPrompt = fullPrompt.trim().toLowerCase();
  const normalizedGlossary = glossaryContent.trim().toLowerCase();

  const firstLineOfGlossary = normalizedGlossary.split("\n")[0]?.trim() ?? "";

  const distanceFull = levenshteinDistance(
    normalizedTranscription,
    normalizedPrompt,
  );
  const distanceContent = levenshteinDistance(
    normalizedTranscription,
    normalizedGlossary,
  );
  const distanceFirstLine = levenshteinDistance(
    normalizedTranscription,
    firstLineOfGlossary,
  );

  const maxLengthFull = Math.max(
    normalizedTranscription.length,
    normalizedPrompt.length,
  );
  const maxLengthContent = Math.max(
    normalizedTranscription.length,
    normalizedGlossary.length,
  );
  const maxLengthFirstLine = Math.max(
    normalizedTranscription.length,
    firstLineOfGlossary.length,
  );

  const differenceFull = maxLengthFull > 0 ? distanceFull / maxLengthFull : 0;
  const differenceContent =
    maxLengthContent > 0 ? distanceContent / maxLengthContent : 0;
  const differenceFirstLine =
    maxLengthFirstLine > 0 ? distanceFirstLine / maxLengthFirstLine : 0;

  return (
    differenceFull < TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD ||
    differenceContent < TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD ||
    differenceFirstLine < TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD
  );
}

function resolveBedrockConfig(): BedrockEvalConfig {
  const inputBucket = config.bedrock.dataAutomationInputBucket;
  const outputBucket = config.bedrock.dataAutomationOutputBucket;

  if (!config.bedrock.dataAutomationProfileArn) {
    throw new Error(
      "BEDROCK_DATA_AUTOMATION_PROFILE_ARN is required for Bedrock evals.",
    );
  }
  if (!inputBucket || !outputBucket) {
    throw new Error(
      "BEDROCK_DATA_AUTOMATION_INPUT_BUCKET or TRANSCRIPTS_BUCKET is required for Bedrock evals.",
    );
  }
  if (config.storage.endpoint) {
    throw new Error(
      "Bedrock evals require AWS S3. STORAGE_ENDPOINT is set to a custom value.",
    );
  }

  return {
    dataAutomationProfileArn: config.bedrock.dataAutomationProfileArn,
    dataAutomationProjectArn: config.bedrock.dataAutomationProjectArn,
    inputBucket,
    outputBucket,
    inputPrefix: config.bedrock.dataAutomationInputPrefix,
    outputPrefix: config.bedrock.dataAutomationOutputPrefix,
    pollIntervalMs: config.bedrock.dataAutomationPollIntervalMs,
    timeoutMs: config.bedrock.dataAutomationTimeoutMs,
  };
}

function parseOptions(): EvalOptions {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const file = readFlagValue("--file") ?? readFlagValue("-f") ?? undefined;

  const runs = Number(readFlagValue("--runs") ?? "5");
  if (!Number.isFinite(runs) || runs <= 0) {
    throw new Error("--runs must be a positive number.");
  }

  const model =
    readFlagValue("--model") ?? getModelChoice("transcription").model;
  const language = readFlagValue("--language") ?? "en";
  const temperatureValue = readFlagValue("--temperature");
  const temperature =
    temperatureValue !== undefined ? Number(temperatureValue) : undefined;
  if (temperatureValue !== undefined && !Number.isFinite(temperature)) {
    throw new Error("--temperature must be a number.");
  }

  const delayMs = Number(readFlagValue("--delay-ms") ?? "0");
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error("--delay-ms must be a non-negative number.");
  }

  const prompt = readFlagValue("--prompt");
  const promptFile = readFlagValue("--prompt-file");
  const glossaryFile = readFlagValue("--glossary-file");
  const reference = readFlagValue("--reference");
  const referenceFile = readFlagValue("--reference-file");

  const providerRaw = (readFlagValue("--provider") ?? "openai").toLowerCase();
  if (providerRaw !== "openai" && providerRaw !== "bedrock") {
    throw new Error("Only --provider openai or bedrock is supported for now.");
  }
  const provider = providerRaw as ProviderName;

  const datasetFlag =
    readFlagValue("--langfuse-dataset") ?? readFlagValue("--dataset");
  const experimentFlag =
    readFlagValue("--langfuse-experiment") ?? readFlagValue("--experiment");
  const envDataset = process.env.LANGFUSE_EVAL_DATASET;
  const useDataset = Boolean(datasetFlag ?? (!file && envDataset));
  const langfuseDataset = datasetFlag ?? (useDataset ? envDataset : undefined);
  const langfuseExperiment =
    experimentFlag ?? process.env.LANGFUSE_EVAL_EXPERIMENT;

  if (!file && !langfuseDataset) {
    throw new Error("Missing required --file argument.");
  }

  return {
    file,
    runs,
    model,
    language,
    temperature,
    prompt,
    promptFile,
    glossaryFile,
    delayMs,
    trace: hasFlag("--trace"),
    dropPromptLike: hasFlag("--drop-prompt-like"),
    output: readFlagValue("--output"),
    quiet: hasFlag("--quiet"),
    reference,
    referenceFile,
    provider,
    langfuseDataset,
    langfuseExperiment,
    useDataset,
    compareNoPrompt: hasFlag("--compare-no-prompt"),
  };
}

async function resolvePrompt(
  options: PromptInputs,
): Promise<{ prompt: string; glossary: string }> {
  const promptFromFile = await readPromptFileContent(options.promptFile);
  const glossaryFromFile = await readOptionalFile(options.glossaryFile);
  return {
    prompt: options.prompt ?? promptFromFile ?? "",
    glossary: glossaryFromFile ?? "",
  };
}

async function resolveReference(
  options: ReferenceInputs,
): Promise<string | undefined> {
  const referenceFromFile = await readOptionalFile(options.referenceFile);
  return options.reference ?? referenceFromFile;
}

function extractTranscriptFromBda(payload: unknown): string {
  const parsed = BdaOutputSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.audio_segments) {
    return "";
  }

  const segments = parsed.data.audio_segments;
  const transcriptSegments = segments.filter(
    (segment) => (segment.type ?? "").toUpperCase() === "TRANSCRIPT",
  );
  const selected =
    transcriptSegments.length > 0 ? transcriptSegments : segments;
  const ordered = selected
    .filter((segment) => segment.text && segment.text.trim().length > 0)
    .sort(
      (a, b) =>
        (a.start_timestamp_millis ?? 0) - (b.start_timestamp_millis ?? 0),
    );

  return ordered.map((segment) => segment.text?.trim()).join(" ");
}

async function waitForBedrockOutput(
  client: BedrockDataAutomationRuntimeClient,
  invocationArn: string,
  config: BedrockEvalConfig,
): Promise<GetDataAutomationStatusCommandOutput> {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const status = await client.send(
      new GetDataAutomationStatusCommand({ invocationArn }),
    );
    const state = status.status ?? "Unknown";
    if (state === "Success") {
      return status;
    }
    if (state === "ServiceError" || state === "ClientError") {
      const message = status.errorMessage ?? "Unknown Bedrock error.";
      const errorType = status.errorType ?? "UnknownError";
      throw new Error(
        `Bedrock Data Automation failed: ${errorType} ${message}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }
  throw new Error("Timed out waiting for Bedrock Data Automation output.");
}

async function readJsonFromS3(
  client: S3Client,
  s3Uri: string,
): Promise<unknown> {
  const { bucket, key } = parseS3Uri(s3Uri);
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!response.Body) {
    throw new Error(`Empty S3 response body for ${s3Uri}`);
  }
  const body = await streamToString(response.Body as Readable);
  return JSON.parse(body);
}

async function transcribeWithOpenAI(
  client: ReturnType<typeof createOpenAIClient>,
  filePath: string,
  options: {
    model: string;
    language: string;
    prompt: string;
    temperature?: number;
  },
): Promise<string> {
  const request: TranscriptionCreateParamsNonStreaming<"json"> = {
    file: createReadStream(filePath),
    model: options.model,
    language: options.language,
    response_format: "json",
  };

  if (options.prompt) {
    request.prompt = options.prompt;
  }
  if (options.temperature !== undefined) {
    request.temperature = options.temperature;
  }

  const response = await client.audio.transcriptions.create(request);
  return response.text ?? "";
}

async function transcribeWithBedrock(
  bedrockClient: BedrockDataAutomationRuntimeClient,
  s3Client: S3Client,
  filePath: string,
  bedrockConfig: BedrockEvalConfig,
): Promise<string> {
  const inputKey = `${stripLeadingSlash(
    ensureTrailingSlash(bedrockConfig.inputPrefix),
  )}${randomUUID()}-${path.basename(filePath)}`;
  const outputPrefix = `${stripLeadingSlash(
    ensureTrailingSlash(bedrockConfig.outputPrefix),
  )}${randomUUID()}/`;
  const inputS3Uri = buildS3Uri(bedrockConfig.inputBucket, inputKey);
  const outputS3Uri = buildS3Uri(bedrockConfig.outputBucket, outputPrefix);

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bedrockConfig.inputBucket,
      Key: inputKey,
      Body: createReadStream(filePath),
    }),
  );

  const invokeResponse = await bedrockClient.send(
    new InvokeDataAutomationAsyncCommand({
      dataAutomationProfileArn: bedrockConfig.dataAutomationProfileArn,
      dataAutomationConfiguration: bedrockConfig.dataAutomationProjectArn
        ? {
            dataAutomationProjectArn: bedrockConfig.dataAutomationProjectArn,
          }
        : undefined,
      inputConfiguration: {
        s3Uri: inputS3Uri,
      },
      outputConfiguration: {
        s3Uri: outputS3Uri,
      },
    }),
  );

  if (!invokeResponse.invocationArn) {
    throw new Error(
      "Bedrock Data Automation did not return an invocation ARN.",
    );
  }

  const status = await waitForBedrockOutput(
    bedrockClient,
    invokeResponse.invocationArn,
    bedrockConfig,
  );
  const outputUri = status.outputConfiguration?.s3Uri;
  if (!outputUri) {
    throw new Error("Bedrock Data Automation did not return an output URI.");
  }

  const payload = await readJsonFromS3(s3Client, outputUri);
  return extractTranscriptFromBda(payload);
}

async function runTranscriptionBatch(inputs: BatchInputs): Promise<EvalOutput> {
  const results: EvalResult[] = [];
  const counts = new Map<string, number>();
  let promptLikeCount = 0;
  let trivialTextCount = 0;
  let totalDurationMs = 0;

  for (let i = 0; i < inputs.runs; i += 1) {
    const start = Date.now();
    const rawText = await inputs.transcribeOnce();
    const durationMs = Date.now() - start;
    totalDurationMs += durationMs;

    const normalized = normalize(rawText);
    const promptLike = Boolean(
      (inputs.prompt || inputs.glossary) &&
      isTranscriptionLikelyPrompt(normalized, inputs.prompt, inputs.glossary),
    );

    const finalText = inputs.dropPromptLike && promptLike ? "" : normalized;

    if (promptLike) {
      promptLikeCount += 1;
    }

    const trivialText = getTranscriptionTextQuality(finalText).trivial;
    if (trivialText) {
      trivialTextCount += 1;
    }

    const distributionKey = finalText.length > 0 ? finalText : "[empty]";
    counts.set(distributionKey, (counts.get(distributionKey) ?? 0) + 1);

    results.push({
      run: i + 1,
      text: finalText,
      promptLike: Boolean(promptLike),
      trivialText,
      durationMs,
    });

    if (!inputs.quiet) {
      console.log(
        `[${i + 1}/${inputs.runs}] ${durationMs}ms ${promptLike ? "[prompt-like] " : ""}${finalText}`,
      );
    }

    if (inputs.delayMs > 0 && i < inputs.runs - 1) {
      await new Promise((resolve) => setTimeout(resolve, inputs.delayMs));
    }
  }

  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const topEntry = sorted[0] ?? ["", 0];
  const distribution = sorted.map(([text, count]) => ({ text, count }));
  const topStability = inputs.runs > 0 ? topEntry[1] / inputs.runs : 0;
  const avgDurationMs = inputs.runs > 0 ? totalDurationMs / inputs.runs : 0;

  return {
    text: topEntry[0] ?? "",
    runs: inputs.runs,
    promptLikeCount,
    trivialTextCount,
    uniqueOutputs: counts.size,
    distribution,
    results,
    topStability,
    avgDurationMs,
  };
}

function printSummary(output: EvalOutput, reference?: string) {
  console.log("");
  console.log("Transcription eval summary");
  console.log(`Runs: ${output.runs}`);
  console.log(`Unique outputs: ${output.uniqueOutputs}`);
  console.log(`Prompt-like outputs: ${output.promptLikeCount}`);
  console.log(`Trivial outputs: ${output.trivialTextCount}`);
  console.log(`Top stability: ${output.topStability.toFixed(2)}`);
  console.log(`Average latency: ${Math.round(output.avgDurationMs)}ms`);
  if (reference) {
    const wer = wordErrorRate(reference, output.text);
    if (wer !== null) {
      console.log(`WER: ${wer.toFixed(3)}`);
    }
  }
  console.log("Top outputs:");
  output.distribution.slice(0, 5).forEach(({ text, count }) => {
    console.log(`- ${count}x ${text}`);
  });
}

function printComparisonSummary(
  output: EvalComparisonOutput,
  reference?: string,
) {
  console.log("");
  console.log("Prompt mode comparison");
  console.log(
    `- with prompt: ${output.withPrompt.text || "[empty]"} (prompt-like ${output.withPrompt.promptLikeCount}/${output.withPrompt.runs}, trivial ${output.withPrompt.trivialTextCount}/${output.withPrompt.runs})`,
  );
  console.log(
    `- no prompt: ${output.withoutPrompt.text || "[empty]"} (prompt-like ${output.withoutPrompt.promptLikeCount}/${output.withoutPrompt.runs}, trivial ${output.withoutPrompt.trivialTextCount}/${output.withoutPrompt.runs})`,
  );
  if (reference) {
    const withPromptWer = wordErrorRate(reference, output.withPrompt.text);
    const withoutPromptWer = wordErrorRate(
      reference,
      output.withoutPrompt.text,
    );
    if (withPromptWer !== null) {
      console.log(`- with prompt WER: ${withPromptWer.toFixed(3)}`);
    }
    if (withoutPromptWer !== null) {
      console.log(`- no prompt WER: ${withoutPromptWer.toFixed(3)}`);
    }
  }
}

async function writeOutputFile(outputPath: string, payload: unknown) {
  const resolved = path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, JSON.stringify(payload, null, 2), "utf8");
}

async function runFileEval(options: EvalOptions) {
  if (!options.file) {
    throw new Error("Missing required --file argument.");
  }

  const { prompt, glossary } = await resolvePrompt({
    prompt: options.prompt,
    promptFile: options.promptFile,
    glossaryFile: options.glossaryFile,
  });
  const reference = await resolveReference({
    reference: options.reference,
    referenceFile: options.referenceFile,
  });

  const filePath = path.resolve(process.cwd(), options.file);
  await fs.access(filePath);

  const buildTranscribeOnce = (promptOverride: string) =>
    options.provider === "openai"
      ? (() => {
          const client = createOpenAIClient({
            traceName: options.trace ? "transcription-eval" : undefined,
            generationName: options.trace ? "transcription-eval" : undefined,
            tags: options.trace ? ["eval:transcription"] : undefined,
            disableTracing: !options.trace,
          });
          return () =>
            transcribeWithOpenAI(client, filePath, {
              model: options.model,
              language: options.language,
              prompt: promptOverride,
              temperature: options.temperature,
            });
        })()
      : (() => {
          const bedrockConfig = resolveBedrockConfig();
          const region = config.storage.awsRegion;
          const bedrockClient = new BedrockDataAutomationRuntimeClient({
            region,
          });
          const s3Client = new S3Client({ region });
          return () =>
            transcribeWithBedrock(
              bedrockClient,
              s3Client,
              filePath,
              bedrockConfig,
            );
        })();

  const runBatchForPrompt = async (promptOverride: string) =>
    await runTranscriptionBatch({
      transcribeOnce: buildTranscribeOnce(promptOverride),
      runs: options.runs,
      prompt: promptOverride,
      glossary,
      delayMs: options.delayMs,
      dropPromptLike: options.dropPromptLike,
      quiet: options.quiet,
    });

  const output = await runBatchForPrompt(prompt);

  printSummary(output, reference);

  let comparisonOutput: EvalComparisonOutput | undefined;
  if (options.compareNoPrompt) {
    const withoutPrompt = await runBatchForPrompt("");
    comparisonOutput = {
      withPrompt: output,
      withoutPrompt,
    };
    printComparisonSummary(comparisonOutput, reference);
  }

  if (options.output) {
    const payload = {
      provider: options.provider,
      model: options.model,
      file: options.file,
      runs: options.runs,
      language: options.language,
      temperature: options.temperature ?? null,
      promptLength: prompt.length,
      glossaryLength: glossary.length,
      output,
      comparison: comparisonOutput,
      referenceLength: reference?.length ?? 0,
    };
    await writeOutputFile(options.output, payload);
    console.log(`\nSaved results to ${options.output}`);
  }
}

async function runLangfuseEval(options: EvalOptions) {
  if (!isLangfuseEnabled()) {
    throw new Error("Langfuse keys are required to run dataset evals.");
  }

  const datasetName =
    options.langfuseDataset ?? process.env.LANGFUSE_EVAL_DATASET;
  if (!datasetName) {
    throw new Error("Langfuse dataset name is required.");
  }

  const experimentName =
    options.langfuseExperiment ??
    process.env.LANGFUSE_EVAL_EXPERIMENT ??
    `transcription-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const langfuse = getLangfuseClient();
  if (!langfuse) {
    throw new Error("Langfuse client is unavailable.");
  }

  const openAiClient =
    options.provider === "openai"
      ? createOpenAIClient({
          traceName: options.trace ? "transcription-eval" : undefined,
          generationName: options.trace ? "transcription-eval" : undefined,
          tags: options.trace ? ["eval:transcription"] : undefined,
          disableTracing: !options.trace,
        })
      : null;
  const bedrockConfig =
    options.provider === "bedrock" ? resolveBedrockConfig() : null;
  const region = config.storage.awsRegion;
  const bedrockClient =
    options.provider === "bedrock"
      ? new BedrockDataAutomationRuntimeClient({ region })
      : null;
  const s3Client =
    options.provider === "bedrock" ? new S3Client({ region }) : null;

  const dataset = await langfuse.dataset.get(datasetName);

  const result = await dataset.runExperiment({
    name: experimentName,
    task: async (item) => {
      const input = DatasetInputSchema.parse(item.input);
      const { prompt, glossary } = await resolvePrompt({
        prompt: input.prompt ?? options.prompt,
        promptFile: input.promptFile ?? options.promptFile,
        glossaryFile: input.glossaryFile ?? options.glossaryFile,
      });

      const filePath = path.resolve(process.cwd(), input.file);
      await fs.access(filePath);

      const output = await runTranscriptionBatch({
        transcribeOnce:
          options.provider === "openai"
            ? () =>
                transcribeWithOpenAI(openAiClient!, filePath, {
                  model: options.model,
                  language: input.language ?? options.language,
                  prompt,
                  temperature: input.temperature ?? options.temperature,
                })
            : () =>
                transcribeWithBedrock(
                  bedrockClient!,
                  s3Client!,
                  filePath,
                  bedrockConfig!,
                ),
        runs: input.runs ?? options.runs,
        prompt,
        glossary,
        delayMs: options.delayMs,
        dropPromptLike: options.dropPromptLike,
        quiet: true,
      });

      return output;
    },
    evaluators: [
      async ({ output, expectedOutput }) => {
        const parsedOutput = EvalOutputSchema.parse(output);
        const expected = DatasetExpectedSchema.parse(expectedOutput);
        const evaluations = [
          {
            name: "prompt_like_rate",
            value:
              parsedOutput.runs > 0
                ? parsedOutput.promptLikeCount / parsedOutput.runs
                : 0,
          },
          {
            name: "unique_outputs",
            value: parsedOutput.uniqueOutputs,
          },
          {
            name: "top_stability",
            value: parsedOutput.topStability,
          },
        ];

        if (expected?.transcript) {
          const wer = wordErrorRate(expected.transcript, parsedOutput.text);
          const exactMatch =
            normalizeForCompare(expected.transcript) ===
            normalizeForCompare(parsedOutput.text)
              ? 1
              : 0;
          if (wer !== null) {
            evaluations.push({
              name: "wer",
              value: wer,
            });
          }
          evaluations.push({
            name: "exact_match",
            value: exactMatch,
          });
        }

        return evaluations;
      },
    ],
  });

  console.log(await result.format());
  await langfuse.shutdown();
}

async function runEval() {
  const options = parseOptions();
  if (options.provider === "openai" && !config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required to run transcription evals.");
  }

  if (options.useDataset) {
    await runLangfuseEval(options);
    return;
  }

  await runFileEval(options);
}

runEval().catch((error) => {
  console.error("Transcription eval failed:", error);
  process.exit(1);
});
