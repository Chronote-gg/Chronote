import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { distance as levenshteinDistance } from "fastest-levenshtein";
import { TRANSCRIPTION_PROMPT_SIMILARITY_THRESHOLD } from "../constants";

type PromptChatMessage = {
  role?: string;
  content?: string;
};

type PromptFrontMatter = {
  type?: string;
  messages?: PromptChatMessage[];
  prompt?: PromptChatMessage[];
};

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

export async function readPromptFileContent(
  value?: string,
): Promise<string | undefined> {
  if (!value) return undefined;
  const resolved = path.resolve(process.cwd(), value);
  const raw = await fs.readFile(resolved, "utf8");
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return raw.trim();
  }
  const parsed = matter(raw, {
    engines: { yaml: (input) => parseYaml(input) as object },
  });
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

export function isTranscriptionLikelyPrompt(
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
