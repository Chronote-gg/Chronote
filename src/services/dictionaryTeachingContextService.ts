import { DICTIONARY_TEACHING_CONTEXT_MAX_LENGTH } from "../types/dictionaryTeaching";

const STOP_WORDS = new Set([
  "about",
  "actually",
  "and",
  "also",
  "been",
  "but",
  "chronote",
  "correct",
  "correction",
  "from",
  "his",
  "have",
  "into",
  "name",
  "notes",
  "really",
  "should",
  "that",
  "the",
  "their",
  "there",
  "they",
  "this",
  "transcript",
  "what",
  "with",
  "wrote",
]);

const tokensFor = (value: string) =>
  Array.from(
    new Set(
      value
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
    ),
  ).slice(0, 30);

const tokenSetFor = (value: string) =>
  new Set(
    value
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );

const splitTranscript = (transcript: string) => {
  const lines = transcript
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 1) return lines;
  return (
    transcript
      .match(/.{1,500}(?:\s|$)/g)
      ?.map((chunk) => chunk.trim())
      .filter(Boolean) ?? []
  );
};

export function selectDictionaryTeachingTranscriptExcerpt(params: {
  transcript: string;
  instruction: string;
  notesDiff: string;
  maxChars?: number;
}) {
  const maxChars = Math.max(
    0,
    Math.min(
      params.maxChars ?? Math.floor(DICTIONARY_TEACHING_CONTEXT_MAX_LENGTH / 2),
      DICTIONARY_TEACHING_CONTEXT_MAX_LENGTH,
    ),
  );
  if (!params.transcript.trim() || maxChars === 0) return "";
  const tokens = tokensFor(`${params.instruction}\n${params.notesDiff}`);
  if (tokens.length === 0) return "";
  const ranked = splitTranscript(params.transcript)
    .map((text, index) => {
      const transcriptTokens = tokenSetFor(text);
      return {
        index,
        text,
        score: tokens.reduce(
          (score, token) => score + (transcriptTokens.has(token) ? 1 : 0),
          0,
        ),
      };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6)
    .sort((a, b) => a.index - b.index);

  const selected: string[] = [];
  let chars = 0;
  for (const candidate of ranked) {
    const separator = selected.length > 0 ? 1 : 0;
    const remaining = maxChars - chars - separator;
    if (remaining <= 0) break;
    selected.push(candidate.text.slice(0, remaining));
    chars += Math.min(candidate.text.length, remaining) + separator;
  }
  return selected.join("\n");
}

export function boundDictionaryTeachingNotesDiff(
  notesDiff: string,
  maxChars = Math.floor(DICTIONARY_TEACHING_CONTEXT_MAX_LENGTH / 2),
) {
  const trimmed = notesDiff.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n… [truncated]`;
}
