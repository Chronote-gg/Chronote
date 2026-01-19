import type OpenAI from "openai";
import type { SpanContext } from "@opentelemetry/api";
import { ChatEntry } from "./types/chat";
import { renderChatEntryLine } from "./utils/chatLog";
import {
  createReadStream,
  existsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  BYTES_PER_SAMPLE,
  CHANNELS,
  RECORD_SAMPLE_RATE,
  TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES,
  TRANSCRIPTION_BREAK_DURATION,
  TRANSCRIPTION_GLOSSARY_TERM_ONLY_MAX_SECONDS,
  LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT,
  LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME,
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
  TRANSCRIPTION_MAX_RETRIES,
  TRANSCRIPTION_RATE_MIN_TIME,
  TRANSCRIBE_SAMPLE_RATE,
} from "./constants";
import ffmpeg from "fluent-ffmpeg";
import { AudioSnippet, TranscriptVariant } from "./types/audio";
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleAll,
  retry,
  wrap,
} from "cockatiel";
import { MeetingData } from "./types/meeting-data";
import Bottleneck from "bottleneck";
import {
  buildMeetingContext,
  formatContextForPrompt,
  isMemoryEnabled,
} from "./services/contextService";
import { config } from "./services/configService";
import { formatParticipantLabel } from "./utils/participants";
import { getBotNameVariants } from "./utils/botNames";
import { createOpenAIClient } from "./services/openaiClient";
import { buildModelOverrides, getModelChoice } from "./services/modelFactory";
import { resolveChatParamsForRole } from "./services/openaiModelParams";
import {
  buildDictionaryPromptLines,
  DEFAULT_DICTIONARY_BUDGETS,
} from "./utils/dictionary";
import {
  buildGlossaryTermSet,
  getPromptSimilarityMetrics,
  isGlossaryTermOnlyTranscript,
} from "./utils/transcriptionGuards";
import type { ModelParamRole } from "./config/types";
import {
  getLangfuseChatPrompt,
  type LangfusePromptMeta,
} from "./services/langfusePromptService";
import { isLangfuseTracingEnabled } from "./services/langfuseClient";
import {
  startActiveObservation,
  updateActiveObservation,
  updateActiveTrace,
} from "@langfuse/tracing";
import { buildLangfuseTranscriptionAudioAttachment } from "./observability/langfuseAudioAttachment";
import { buildLangfuseTranscriptionUsageDetails } from "./observability/langfuseUsageDetails";
import { ensureMeetingTempDirSync } from "./services/tempFileService";
// import { Transcription, TranscriptionVerbose } from "openai/resources/audio/transcriptions";

type TranscriptionGuardResult = {
  text: string;
  flags: string[];
  promptSimilarity: ReturnType<typeof getPromptSimilarityMetrics>;
  glossaryTermOnly: boolean;
};

export function applyTranscriptionGuards(
  meeting: MeetingData,
  transcription: string,
  prompt: string,
  glossaryContent: string,
  context?: TranscriptionTraceContext,
): TranscriptionGuardResult {
  const trimmed = transcription.trim();
  const suppressionEnabled =
    meeting.runtimeConfig?.transcription.suppressionEnabled ?? true;
  const promptSimilarity = getPromptSimilarityMetrics({
    transcription: trimmed,
    fullPrompt: prompt,
    glossaryContent,
  });
  if (!suppressionEnabled) {
    return {
      text: trimmed,
      flags: [],
      promptSimilarity,
      glossaryTermOnly: false,
    };
  }
  const termSet = buildGlossaryTermSet({
    serverName: meeting.guild.name,
    channelName: meeting.voiceChannel.name,
    dictionaryTerms: meeting.dictionaryEntries?.map((entry) => entry.term),
  });
  const glossaryTermOnly = isGlossaryTermOnlyTranscript(trimmed, termSet);
  const flags: string[] = [];

  if (promptSimilarity.isPromptLike) {
    flags.push("prompt_like");
  }

  const maxGlossarySeconds = TRANSCRIPTION_GLOSSARY_TERM_ONLY_MAX_SECONDS;
  const audioSeconds = context?.audioSeconds ?? 0;
  const shouldSuppressGlossaryTerm =
    glossaryTermOnly && audioSeconds > 0 && audioSeconds < maxGlossarySeconds;

  if (glossaryTermOnly) {
    flags.push("glossary_term_only");
  }

  const shouldSuppressPromptLike = promptSimilarity.isPromptLike;
  const text =
    shouldSuppressGlossaryTerm || shouldSuppressPromptLike ? "" : trimmed;
  if (shouldSuppressGlossaryTerm) {
    flags.push("glossary_term_suppressed");
  }
  if (shouldSuppressPromptLike) {
    flags.push("prompt_suppressed");
  }

  return { text, flags, promptSimilarity, glossaryTermOnly };
}

type TranscriptionTraceContext = {
  userId: string;
  timestamp: number;
  audioSeconds: number;
  audioBytes: number;
};

const getMeetingModelOverrides = (meeting: MeetingData) =>
  buildModelOverrides(meeting.runtimeConfig?.modelChoices);

async function transcribeInternal(
  meeting: MeetingData,
  file: string,
  context?: TranscriptionTraceContext,
): Promise<string> {
  const glossaryContent = getTranscriptionGlossaryContent(meeting);
  const prompt = getTranscriptionKeywords(meeting);

  const modelChoice = getModelChoice(
    "transcription",
    getMeetingModelOverrides(meeting),
  );
  const traceMetadata = {
    guildId: meeting.guild.id,
    channelId: meeting.voiceChannel.id,
    meetingId: meeting.meetingId,
    snippetUserId: context?.userId,
    snippetTimestamp: context?.timestamp,
    audioSeconds: context?.audioSeconds,
    audioBytes: context?.audioBytes,
    promptLength: prompt.length,
  };

  const runTranscription = async (openAIClient: OpenAI) => {
    const transcription = await openAIClient.audio.transcriptions.create({
      file: createReadStream(file),
      model: modelChoice.model,
      language: "en",
      prompt: prompt,
      temperature: 0,
      response_format: "json",
      // include: ["logprobs"],
    });
    return transcription.text;
  };

  const applyGuardsAndLog = (rawText: string) => {
    const guardResult = applyTranscriptionGuards(
      meeting,
      rawText,
      prompt,
      glossaryContent,
      context,
    );

    if (guardResult.flags.length > 0) {
      console.warn("Transcription flagged by guard checks.", {
        ...traceMetadata,
        flags: guardResult.flags,
        promptSimilarity: guardResult.promptSimilarity,
        glossaryTermOnly: guardResult.glossaryTermOnly,
        transcriptionLength: guardResult.text.length,
      });
    }

    return guardResult;
  };

  if (!isLangfuseTracingEnabled()) {
    const openAIClient = createOpenAIClient({
      traceName: "transcription",
      generationName: "transcription",
      userId: meeting.creator.id,
      sessionId: meeting.meetingId,
      tags: ["feature:transcription"],
      metadata: traceMetadata,
    });
    const output = await runTranscription(openAIClient);
    return applyGuardsAndLog(output).text;
  }

  return await startActiveObservation(
    "transcription",
    async () => {
      updateActiveTrace({
        name: "transcription",
        userId: context?.userId,
        tags: ["feature:transcription"],
        metadata: traceMetadata,
      });
      const observationInput = {
        language: "en",
        prompt,
      };
      updateActiveObservation(
        {
          input: observationInput,
          model: modelChoice.model,
          modelParameters: {
            temperature: 0,
            response_format: "json",
          },
          metadata: traceMetadata,
        },
        { asType: "generation" },
      );

      void langfuseAttachmentLimiter
        .schedule(() => buildLangfuseTranscriptionAudioAttachment(file))
        .then((audioAttachment) => {
          if (!audioAttachment) return;
          updateActiveObservation(
            {
              input: {
                ...observationInput,
                audio: audioAttachment.media,
              },
              metadata: {
                audioAttachmentBytes: audioAttachment.byteLength,
                audioAttachmentContentType: audioAttachment.contentType,
              },
            },
            { asType: "generation" },
          );
        })
        .catch((error) => {
          console.warn(
            "Failed to attach transcription audio to Langfuse.",
            error,
          );
        });

      const openAIClient = createOpenAIClient({ disableTracing: true });
      const output = await runTranscription(openAIClient);
      const guardResult = applyGuardsAndLog(output);

      const usageDetails = buildLangfuseTranscriptionUsageDetails(
        context?.audioSeconds,
      );
      updateActiveObservation(
        {
          output: guardResult.text,
          usageDetails,
          metadata: {
            transcriptionFlags: guardResult.flags,
            promptSimilarity: guardResult.promptSimilarity,
            glossaryTermOnly: guardResult.glossaryTermOnly,
          },
        },
        { asType: "generation" },
      );

      return guardResult.text;
    },
    { asType: "generation" },
  );
}

const retryPolicy = retry(handleAll, {
  maxAttempts: TRANSCRIPTION_MAX_RETRIES,
  backoff: new ExponentialBackoff(),
});
const breakerPolicy = circuitBreaker(handleAll, {
  halfOpenAfter: TRANSCRIPTION_BREAK_DURATION,
  breaker: new ConsecutiveBreaker(
    TRANSCRIPTION_BREAK_AFTER_CONSECUTIVE_FAILURES,
  ),
});
const bulkheadPolicy = bulkhead(
  TRANSCRIPTION_MAX_CONCURRENT,
  TRANSCRIPTION_MAX_QUEUE,
);

const policies = wrap(bulkheadPolicy, breakerPolicy, retryPolicy);

const limiter = new Bottleneck({
  minTime: TRANSCRIPTION_RATE_MIN_TIME,
});

const langfuseAttachmentLimiter = new Bottleneck({
  maxConcurrent: LANGFUSE_AUDIO_ATTACHMENT_MAX_CONCURRENT,
  minTime: LANGFUSE_AUDIO_ATTACHMENT_MIN_TIME,
});

async function transcribe(
  meeting: MeetingData,
  file: string,
  context?: TranscriptionTraceContext,
): Promise<string> {
  return await policies.execute(() =>
    limiter.schedule(() => transcribeInternal(meeting, file, context)),
  );
}

export async function transcribeSnippet(
  meeting: MeetingData,
  snippet: AudioSnippet,
  options: { tempSuffix?: string } = {},
): Promise<string> {
  const suffix = options.tempSuffix ? `_${options.tempSuffix}` : "";
  const tempDir = ensureMeetingTempDirSync(meeting);
  const tempPcmFileName = path.join(
    tempDir,
    `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}_transcript.pcm`,
  );
  const tempWavFileName = path.join(
    tempDir,
    `temp_snippet_${snippet.userId}_${snippet.timestamp}${suffix}.wav`,
  );

  // Write the PCM buffer to a file
  const buffer = Buffer.concat(snippet.chunks);
  const audioBytes = buffer.length;
  const audioSeconds =
    audioBytes / (RECORD_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE);
  writeFileSync(tempPcmFileName, buffer);

  // Convert PCM to WAV using ffmpeg
  await new Promise<void>((resolve, reject) => {
    ffmpeg(tempPcmFileName)
      .inputOptions([
        `-f s16le`,
        `-ar ${RECORD_SAMPLE_RATE}`,
        `-ac ${CHANNELS}`,
      ])
      .outputOptions([
        `-f wav`,
        `-c:a pcm_s16le`,
        `-ar ${TRANSCRIBE_SAMPLE_RATE}`,
      ])
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        console.error(`Error converting PCM to WAV: ${err.message}`);
        reject(err);
      })
      .save(tempWavFileName); // Ensure this is within the promise chain
  });

  try {
    // Transcribe the WAV file
    const transcription = await transcribe(meeting, tempWavFileName, {
      userId: snippet.userId,
      timestamp: snippet.timestamp,
      audioSeconds,
      audioBytes,
    });

    // Cleanup temporary files
    if (existsSync(tempPcmFileName)) {
      unlinkSync(tempPcmFileName);
    } else {
      console.log("failed cleaning up temp pcm file, continuing");
    }
    if (existsSync(tempWavFileName)) {
      unlinkSync(tempWavFileName);
    } else {
      console.log("failed cleaning up temp wav file, continuing");
    }

    return transcription;
  } catch (e) {
    console.error(
      `Failed to transcribe snippet for user ${snippet.userId}:`,
      e,
    );

    // Cleanup temporary files on error
    if (existsSync(tempPcmFileName)) {
      unlinkSync(tempPcmFileName);
    } else {
      console.log("failed cleaning up temp pcm file, continuing");
    }
    if (existsSync(tempWavFileName)) {
      unlinkSync(tempWavFileName);
    } else {
      console.log("failed cleaning up temp wav file, continuing");
    }

    return `[Transcription failed]`;
  }
}

export async function cleanupTranscription(
  meeting: MeetingData,
  transcription: string,
) {
  const { messages, langfusePrompt } = await getTranscriptionCleanupPrompt(
    meeting,
    transcription,
  );
  const modelChoice = getModelChoice(
    "transcriptionCleanup",
    getMeetingModelOverrides(meeting),
  );
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: modelChoice.model,
      traceName: "transcription-cleanup",
      generationName: "transcription-cleanup",
      tags: ["feature:transcription_cleanup"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "transcriptionCleanup",
    },
  );
}

type CoalesceInput = {
  slowTranscript: string;
  fastTranscripts: TranscriptVariant[];
};

export async function getTranscriptionCoalescePrompt(
  meeting: MeetingData,
  input: CoalesceInput,
) {
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "transcription");
  const fastTranscriptBlock = input.fastTranscripts
    .map((entry) => `- (rev ${entry.revision}) ${entry.text}`)
    .join("\n");

  return await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCoalescePromptName,
    variables: {
      formattedContext,
      serverName: meeting.guild.name,
      voiceChannelName: meeting.voiceChannel.name,
      attendees: Array.from(meeting.attendance).join(", "),
      slowTranscript: input.slowTranscript,
      fastTranscriptBlock,
    },
  });
}

export async function coalesceTranscription(
  meeting: MeetingData,
  input: CoalesceInput,
): Promise<string> {
  const { messages, langfusePrompt } = await getTranscriptionCoalescePrompt(
    meeting,
    input,
  );
  const modelChoice = getModelChoice(
    "transcriptionCoalesce",
    getMeetingModelOverrides(meeting),
  );
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: modelChoice.model,
      traceName: "transcription-coalesce",
      generationName: "transcription-coalesce",
      tags: ["feature:transcription_coalesce"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "transcriptionCoalesce",
    },
  );
}

type ChatInput = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  "model" | "user" | "temperature" | "reasoning_effort" | "verbosity"
>;

type ChatOptions = {
  model?: string;
  traceName?: string;
  generationName?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  langfusePrompt?: LangfusePromptMeta;
  parentSpanContext?: SpanContext;
  modelParamRole?: ModelParamRole;
};

async function chat(
  meeting: MeetingData,
  body: ChatInput,
  options: ChatOptions = {},
): Promise<string> {
  const model =
    options.model ??
    getModelChoice("notes", getMeetingModelOverrides(meeting)).model;
  const modelParamRole = options.modelParamRole ?? "notes";
  const modelParams = resolveChatParamsForRole({
    role: modelParamRole,
    model,
    config: meeting.runtimeConfig?.modelParams?.[modelParamRole],
  });
  const openAIClient = createOpenAIClient({
    traceName: options.traceName ?? "notes",
    generationName: options.generationName ?? "notes",
    userId: meeting.creator.id,
    sessionId: meeting.meetingId,
    tags: options.tags ?? ["feature:notes"],
    metadata: {
      guildId: meeting.guild.id,
      channelId: meeting.voiceChannel.id,
      ...options.metadata,
    },
    langfusePrompt: options.langfusePrompt,
    parentSpanContext: options.parentSpanContext,
  });
  let output: string = "";
  let done: boolean = false;
  let count = 0;
  while (!done) {
    const response = await openAIClient.chat.completions.create({
      model,
      user: meeting.creator.id,
      ...body,
      ...modelParams,
    });
    console.log(
      `Chat completion finish reason: ${response.choices[0].finish_reason} (trace=${options.traceName ?? "notes"} model=${model})`,
    );
    if (response.choices[0].finish_reason !== "length") {
      done = true;
    }
    const responseValue = response.choices[0].message.content;
    output += responseValue;
    body.messages.push({
      role: "assistant",
      content: responseValue,
    });
    count++;
  }
  console.log(
    `Chat took ${count} calls to fully complete due to length (trace=${options.traceName ?? "notes"} model=${model}).`,
  );
  return output;
}

// Generate the inner content of the glossary (without wrapper tags)
function getTranscriptionGlossaryContent(meeting: MeetingData): string {
  const serverName = meeting.voiceChannel.guild.name;
  const channelName = meeting.voiceChannel.name;
  const serverDescription = meeting.guild.description || "";
  const attendees = Array.from(meeting.attendance).join(", ");

  let content = `Server Name: ${serverName}
Channel: ${channelName}`;

  if (serverDescription) {
    content += `\nServer Description: ${serverDescription}`;
  }

  content += `\nAttendees: ${attendees}`;

  const botNames = getBotNameVariants(
    meeting.guild.members.me,
    meeting.guild.client.user,
  );
  if (botNames.length > 0) {
    content += `\nBot Names: ${botNames.join(", ")}`;
  }

  return content;
}

// Get keywords from the server that are likely to help the translation, such as server name, channel names, role names, and attendee names
export function getTranscriptionKeywords(meeting: MeetingData): string {
  let content = getTranscriptionGlossaryContent(meeting);

  const budgets =
    meeting.runtimeConfig?.dictionary ?? DEFAULT_DICTIONARY_BUDGETS;
  const { transcriptionLines } = buildDictionaryPromptLines(
    meeting.dictionaryEntries ?? [],
    budgets,
  );
  if (transcriptionLines.length > 0) {
    content += `\nDictionary terms:\n${transcriptionLines.join("\n")}`;
  }

  // Add meeting context if provided
  if (meeting.meetingContext) {
    content += `\nMeeting Context: ${meeting.meetingContext}`;
  }

  content +=
    "\nTranscript instruction: Do not include any glossary text in the transcript.";

  return `<glossary>(do not include in transcript):
${content}
</glossary>`;
}

export async function getTranscriptionCleanupPrompt(
  meeting: MeetingData,
  transcription: string,
) {
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "transcription");

  const serverName = meeting.guild.name;
  const serverDescription = meeting.guild.description ?? "";
  const roles = meeting.guild.roles
    .valueOf()
    .map((role) => role.name)
    .join(", ");
  const events = meeting.guild.scheduledEvents
    .valueOf()
    .map((event) => event.name)
    .join(", ");
  const channelNames = meeting.guild.channels
    .valueOf()
    .map((channel) => channel.name)
    .join(", ");

  return await getLangfuseChatPrompt({
    name: config.langfuse.transcriptionCleanupPromptName,
    variables: {
      formattedContext,
      attendees: Array.from(meeting.attendance).join(", "),
      serverName,
      serverDescription,
      voiceChannelName: meeting.voiceChannel.name,
      roles,
      events,
      channelNames,
      transcription,
    },
  });
}

export async function getImage(meeting: MeetingData): Promise<string> {
  // Build context data (without memory - visual generation doesn't need history)
  const contextData = await buildMeetingContext(meeting, false);
  const formattedContext = formatContextForPrompt(contextData, "image");
  const briefContext = formattedContext
    ? formattedContext.substring(0, 500)
    : "";
  const briefContextBlock = briefContext ? `Context: ${briefContext}. ` : "";
  const { messages, langfusePrompt } = await getLangfuseChatPrompt({
    name: config.langfuse.imagePromptName,
    variables: {
      briefContextBlock,
      transcript: meeting.finalTranscript ?? "",
    },
  });

  const imagePromptModel = getModelChoice(
    "imagePrompt",
    getMeetingModelOverrides(meeting),
  );
  const imagePrompt = await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      model: imagePromptModel.model,
      traceName: "image-prompt",
      generationName: "image-prompt",
      tags: ["feature:image_prompt"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "imagePrompt",
    },
  );

  console.log(imagePrompt);

  const imageModel = getModelChoice("image", getMeetingModelOverrides(meeting));
  const imageClient = createOpenAIClient({
    traceName: "image",
    generationName: "image",
    userId: meeting.creator.id,
    sessionId: meeting.meetingId,
    tags: ["feature:image"],
    metadata: {
      guildId: meeting.guild.id,
      channelId: meeting.voiceChannel.id,
    },
    parentSpanContext: meeting.langfuseParentSpanContext,
  });
  const response = await imageClient.images.generate({
    model: imageModel.model,
    size: "1024x1024",
    quality: "hd",
    n: 1,
    prompt: imagePrompt!,
  });

  const output = response.data?.[0]?.url;

  return output || "";
}

const MAX_CHAT_LOG_PROMPT_LENGTH = 20000;

function formatChatLogForPrompt(
  chatLog: ChatEntry[],
  maxLength: number = MAX_CHAT_LOG_PROMPT_LENGTH,
): string | undefined {
  if (!chatLog || chatLog.length === 0) {
    return undefined;
  }

  // Drop obvious noise so participant instructions stay visible
  const filtered = chatLog.filter((entry) => entry.type === "message");

  const relevant = filtered.length > 0 ? filtered : chatLog;
  const combinedLines = relevant.map((e) => renderChatEntryLine(e)).join("\n");
  if (!combinedLines) {
    return undefined;
  }

  if (combinedLines.length > maxLength) {
    const trimmed = combinedLines.slice(combinedLines.length - maxLength);
    return "...(recent chat truncated)...\n" + trimmed;
  }

  return combinedLines;
}

function formatParticipantRoster(meeting: MeetingData): string | undefined {
  const participants = Array.from(meeting.participants.values());
  if (participants.length === 0) {
    return undefined;
  }
  return participants
    .map((participant) => {
      const preferred = formatParticipantLabel(participant, {
        includeUsername: false,
        fallbackName: participant.username,
      });
      const username = participant.username || participant.tag || "unknown";
      const displayName = participant.displayName ?? "-";
      const serverNickname = participant.serverNickname ?? "-";
      const profile = `https://discord.com/users/${participant.id}`;
      const mention = `<@${participant.id}>`;
      return `- ${preferred} | username: ${username} | display name: ${displayName} | server nickname: ${serverNickname} | id: ${participant.id} | mention: ${mention} | profile: ${profile}`;
    })
    .join("\n");
}

export async function getNotesPrompt(meeting: MeetingData) {
  // Build context data with memory if enabled
  const contextData = await buildMeetingContext(meeting, isMemoryEnabled());
  const formattedContext = formatContextForPrompt(contextData, "notes");

  const serverName = meeting.guild.name;
  const serverDescription = meeting.guild.description ?? "";
  const roles = meeting.guild.roles
    .valueOf()
    .map((role) => role.name)
    .join(", ");
  const events = meeting.guild.scheduledEvents
    .valueOf()
    .map((event) => event.name)
    .join(", ");
  const channelNames = meeting.guild.channels
    .valueOf()
    .map((channel) => channel.name)
    .join(", ");

  const botDisplayName =
    meeting.guild.members.me?.displayName ||
    meeting.guild.members.me?.nickname ||
    meeting.guild.members.me?.user.username ||
    "Meeting Notes Bot";

  const chatContext = formatChatLogForPrompt(meeting.chatLog);
  const participantRoster = formatParticipantRoster(meeting);

  const longStoryTestMode = config.notes.longStoryTestMode;
  const contextTestMode = config.context.testMode;
  const promptName = longStoryTestMode
    ? config.langfuse.notesLongStoryPromptName
    : contextTestMode
      ? config.langfuse.notesContextTestPromptName
      : config.langfuse.notesPromptName;

  return await getLangfuseChatPrompt({
    name: promptName,
    variables: {
      formattedContext,
      botDisplayName,
      chatContextInstruction: chatContext
        ? "Use the raw chat provided below to honor any explicit include or omit requests."
        : "No additional participant chat was captured; rely on transcript and provided context.",
      chatContextBlock: chatContext
        ? `Participant chat (recent, raw, chronological):\n${chatContext}`
        : "",
      participantRoster: participantRoster ?? "No participant roster captured.",
      serverName,
      serverDescription,
      voiceChannelName: meeting.voiceChannel.name,
      attendees: Array.from(meeting.attendance).join(", "),
      roles,
      events,
      channelNames,
      longStoryTargetChars: config.notes.longStoryTargetChars,
      transcript: meeting.finalTranscript ?? "",
    },
  });
}

export async function getNotes(meeting: MeetingData): Promise<string> {
  const { messages, langfusePrompt } = await getNotesPrompt(meeting);
  return await chat(
    meeting,
    {
      messages: [...messages],
    },
    {
      traceName: "notes",
      generationName: "notes",
      tags: ["feature:notes"],
      langfusePrompt,
      parentSpanContext: meeting.langfuseParentSpanContext,
      modelParamRole: "notes",
    },
  );
}
