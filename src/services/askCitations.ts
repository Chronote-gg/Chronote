import type { MeetingHistory } from "../types/db";
import type { AskCitation } from "../types/ask";
import { buildPortalMeetingUrl } from "../utils/portalLinks";

type CitationTag = {
  index: number;
  eventId?: string;
};

const CITATION_TAG_REGEX = /<chronote:cite\b[^>]*?\/>/gi;
const MAX_CITATION_TAG_LENGTH = 512;
const ATTRIBUTE_KEYS = new Set(["index", "eventId", "event", "lineId"]);

const isWhitespace = (code: number) =>
  code === 9 || code === 10 || code === 13 || code === 32;

const isAttrKeyChar = (code: number) =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95;

const isTagClose = (raw: string, index: number) =>
  raw[index] === "/" && raw[index + 1] === ">";

const skipWhitespace = (raw: string, start: number) => {
  let i = start;
  while (i < raw.length && isWhitespace(raw.charCodeAt(i))) i += 1;
  return i;
};

const findFirstWhitespace = (raw: string) => {
  for (let i = 0; i < raw.length; i += 1) {
    if (isWhitespace(raw.charCodeAt(i))) return i;
  }
  return -1;
};

const readAttrKey = (raw: string, start: number) => {
  let i = start;
  while (i < raw.length && isAttrKeyChar(raw.charCodeAt(i))) i += 1;
  if (i === start) return { key: undefined, next: start + 1 };
  return { key: raw.slice(start, i), next: i };
};

const skipToSeparator = (raw: string, start: number) => {
  let i = start;
  while (i < raw.length && !isWhitespace(raw.charCodeAt(i))) {
    if (isTagClose(raw, i)) break;
    i += 1;
  }
  return i;
};

const readQuotedValue = (raw: string, start: number) => {
  if (raw[start] !== '"') {
    return { value: undefined, next: skipToSeparator(raw, start) };
  }
  let i = start + 1;
  const valueStart = i;
  while (i < raw.length && raw[i] !== '"') i += 1;
  if (i >= raw.length) return { value: undefined, next: raw.length };
  return { value: raw.slice(valueStart, i), next: i + 1 };
};

const parseCitationAttributes = (raw: string) => {
  const attrs: Record<string, string> = {};
  if (raw.length > MAX_CITATION_TAG_LENGTH) return attrs;

  const len = raw.length;
  let i = findFirstWhitespace(raw);
  if (i === -1) return attrs;

  while (i < len) {
    i = skipWhitespace(raw, i);
    if (i >= len || isTagClose(raw, i)) break;

    const { key, next } = readAttrKey(raw, i);
    i = next;
    if (!key) continue;

    i = skipWhitespace(raw, i);
    if (raw[i] !== "=") {
      i = skipToSeparator(raw, i);
      continue;
    }

    i = skipWhitespace(raw, i + 1);
    const { value, next: valueNext } = readQuotedValue(raw, i);
    i = valueNext;
    if (!value) continue;

    if (ATTRIBUTE_KEYS.has(key)) {
      attrs[key] = value;
    }
  }

  return attrs;
};

const parseCitationTag = (raw: string): CitationTag | null => {
  const attrs = parseCitationAttributes(raw);

  const indexRaw = attrs.index;
  const index = indexRaw ? Number.parseInt(indexRaw, 10) : NaN;
  if (!Number.isFinite(index) || index < 1) return null;

  const eventId = attrs.eventId ?? attrs.event ?? attrs.lineId;
  return { index, eventId };
};

export const extractCitationTags = (text: string): CitationTag[] => {
  const tags: CitationTag[] = [];
  for (const match of text.matchAll(CITATION_TAG_REGEX)) {
    const parsed = parseCitationTag(match[0]);
    if (parsed) {
      tags.push(parsed);
    }
  }
  return tags;
};

export const stripCitationTags = (text: string) =>
  text
    .replace(CITATION_TAG_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();

export const buildAskCitations = (options: {
  text: string;
  meetings: MeetingHistory[];
}): AskCitation[] => {
  const tags = extractCitationTags(options.text);
  const citations: AskCitation[] = [];
  const seen = new Set<string>();

  for (const tag of tags) {
    const meeting = options.meetings[tag.index - 1];
    if (!meeting?.channelId_timestamp) continue;
    const key = `${tag.index}:${tag.eventId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    citations.push({
      index: tag.index,
      meetingId: meeting.channelId_timestamp,
      eventId: tag.eventId,
    });
  }

  return citations;
};

const buildCitationKey = (index: number, eventId?: string) =>
  `${index}:${eventId ?? ""}`;

export const renderAskAnswer = (options: {
  text: string;
  citations: AskCitation[];
  guildId: string;
  portalBaseUrl: string;
}) => {
  const citationMap = new Map(
    options.citations.map((citation) => [
      buildCitationKey(citation.index, citation.eventId),
      citation,
    ]),
  );
  const rendered = options.text.replace(CITATION_TAG_REGEX, (match) => {
    const parsed = parseCitationTag(match);
    if (!parsed) return "";
    const direct = citationMap.get(
      buildCitationKey(parsed.index, parsed.eventId),
    );
    const fallback = citationMap.get(buildCitationKey(parsed.index));
    const citation = direct ?? fallback;
    if (!citation) return `[${parsed.index}]`;
    const url = buildPortalMeetingUrl({
      baseUrl: options.portalBaseUrl,
      guildId: citation.serverId ?? options.guildId,
      meetingId: citation.meetingId,
      eventId: citation.eventId,
    });
    return `[${parsed.index}](${url})`;
  });
  return rendered.trim();
};
