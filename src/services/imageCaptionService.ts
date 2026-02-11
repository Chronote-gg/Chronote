import type OpenAI from "openai";
import type { MeetingData } from "../types/meeting-data";
import type { ChatAttachment, ChatEntry } from "../types/chat";
import { createOpenAIClient } from "./openaiClient";

const DEFAULT_IMAGE_CAPTION_MODEL = "gpt-4o-mini";
const DEFAULT_MAX_IMAGES = 10;
const DEFAULT_MAX_TOTAL_CHARS = 3000;

const MAX_CAPTION_CHARS_PER_IMAGE = 300;
const MAX_VISIBLE_TEXT_CHARS_PER_IMAGE = 800;
const MAX_CAPTION_DURATION_MS = 45_000;
const MAX_CAPTION_REQUEST_MS = 12_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

type CaptionCandidate = {
  entry: ChatEntry;
  attachment: ChatAttachment;
};

type CaptionOutput = {
  caption: string;
  visibleText: string;
};

type CollectCaptionCandidatesOptions = {
  chatLog: ChatEntry[];
  maxImages: number;
};

type CreateCaptionOptions = {
  openAIClient: OpenAI;
  model: string;
  url: string;
  name: string;
  timeoutMs: number;
};

const clampFiniteNumber = (value: unknown, fallback: number) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clampInt = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
) => {
  const parsed = Math.floor(clampFiniteNumber(value, fallback));
  return Math.min(max, Math.max(min, parsed));
};

const stripCodeFences = (text: string): string => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
};

const truncateText = (value: string, maxChars: number): string => {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const trimmed = value.slice(0, maxChars);
  return trimmed.trimEnd();
};

const parseCaptionOutput = (raw: string): CaptionOutput | null => {
  const normalized = stripCodeFences(raw);
  if (!normalized) return null;

  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const caption = typeof record.caption === "string" ? record.caption : "";
    const visibleText =
      typeof record.visibleText === "string" ? record.visibleText : "";
    return {
      caption: caption.trim(),
      visibleText: visibleText.trim(),
    };
  } catch {
    return null;
  }
};

const isSupportedImageContentType = (
  contentType: string | undefined,
): boolean => {
  if (!contentType) return false;
  const lowered = contentType.toLowerCase();
  if (lowered === "image/svg+xml") return false;
  return lowered.startsWith("image/");
};

const resolveFileExtension = (name: string): string | undefined => {
  const lowered = name.toLowerCase();
  const lastDot = lowered.lastIndexOf(".");
  if (lastDot < 0 || lastDot === lowered.length - 1) return undefined;
  return lowered.slice(lastDot + 1);
};

const isSupportedImageName = (name: string | undefined): boolean => {
  if (!name) return false;
  const ext = resolveFileExtension(name);
  if (!ext) return false;
  return IMAGE_EXTENSIONS.has(ext);
};

const isImageAttachment = (attachment: ChatAttachment): boolean => {
  return (
    isSupportedImageContentType(attachment.contentType) ||
    isSupportedImageName(attachment.name)
  );
};

const isAttachmentSizeAllowed = (size: unknown): boolean => {
  const parsed = typeof size === "number" ? size : Number(size);
  if (!Number.isFinite(parsed)) return false;
  if (parsed <= 0) return false;
  return parsed <= MAX_IMAGE_BYTES;
};

const canCaptionAttachment = (attachment: ChatAttachment): boolean => {
  if (!attachment.url) return false;
  if (attachment.ephemeral) return false;
  if (!isAttachmentSizeAllowed(attachment.size)) return false;
  if (!isImageAttachment(attachment)) return false;
  if (attachment.aiCaption || attachment.aiVisibleText) return false;
  return true;
};

const collectCaptionCandidates = (
  options: CollectCaptionCandidatesOptions,
): CaptionCandidate[] => {
  const candidates: CaptionCandidate[] = [];
  const seen = new Set<string>();

  for (let i = options.chatLog.length - 1; i >= 0; i -= 1) {
    if (candidates.length >= options.maxImages) break;
    const entry = options.chatLog[i];
    if (entry.type !== "message") continue;
    const attachments = entry.attachments;
    if (!attachments || attachments.length === 0) continue;

    for (const attachment of attachments) {
      if (candidates.length >= options.maxImages) break;
      if (!attachment || !attachment.id) continue;
      if (!canCaptionAttachment(attachment)) continue;
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);

      candidates.push({ entry, attachment });
    }
  }

  return candidates;
};

const createCaption = async (
  options: CreateCaptionOptions,
): Promise<CaptionOutput | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.openAIClient.chat.completions.create(
      {
        model: options.model,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You caption images shared in a meeting. Return strict JSON only, no markdown. Schema: {"caption": string, "visibleText": string}. caption is 1-2 sentences. visibleText contains clearly visible text in the image, or empty string.',
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Caption this image and extract visible text. Filename: ${options.name}`,
              },
              {
                type: "image_url",
                image_url: {
                  url: options.url,
                  detail: "low",
                },
              },
            ],
          },
        ],
      },
      { signal: controller.signal },
    );

    const raw = response.choices?.[0]?.message?.content ?? "";
    return parseCaptionOutput(raw);
  } finally {
    clearTimeout(timeout);
  }
};

export async function captionMeetingImages(meeting: MeetingData): Promise<{
  candidates: number;
  captioned: number;
  skipped: number;
  truncatedChars: number;
}> {
  const visionConfig = meeting.runtimeConfig?.visionCaptions;
  if (!visionConfig?.enabled) {
    return { candidates: 0, captioned: 0, skipped: 0, truncatedChars: 0 };
  }

  const chatLog = meeting.chatLog;
  if (!chatLog || chatLog.length === 0) {
    return { candidates: 0, captioned: 0, skipped: 0, truncatedChars: 0 };
  }

  const maxImages = clampInt(visionConfig.maxImages, DEFAULT_MAX_IMAGES, 0, 50);
  const maxTotalChars = clampInt(
    visionConfig.maxTotalChars,
    DEFAULT_MAX_TOTAL_CHARS,
    0,
    20000,
  );
  if (maxImages <= 0 || maxTotalChars <= 0) {
    return { candidates: 0, captioned: 0, skipped: 0, truncatedChars: 0 };
  }

  const candidates = collectCaptionCandidates({ chatLog, maxImages });
  if (candidates.length === 0) {
    return { candidates: 0, captioned: 0, skipped: 0, truncatedChars: 0 };
  }

  const openAIClient = createOpenAIClient({
    traceName: "image-caption",
    generationName: "image-caption",
    userId: meeting.creator.id,
    sessionId: meeting.meetingId,
    tags: ["feature:image_caption"],
    metadata: {
      guildId: meeting.guild.id,
      channelId: meeting.voiceChannel.id,
      meetingId: meeting.meetingId,
    },
    parentSpanContext: meeting.langfuseParentSpanContext,
  });

  const startedAt = Date.now();
  const model = DEFAULT_IMAGE_CAPTION_MODEL;
  let remainingChars = maxTotalChars;
  let captioned = 0;
  let skipped = 0;
  let truncatedChars = 0;

  for (const candidate of candidates) {
    const elapsedMs = Date.now() - startedAt;
    const remainingBudgetMs = MAX_CAPTION_DURATION_MS - elapsedMs;
    if (remainingBudgetMs <= 0) {
      break;
    }
    if (remainingChars <= 0) {
      break;
    }

    const { entry, attachment } = candidate;
    try {
      const timeoutMs = Math.min(
        MAX_CAPTION_REQUEST_MS,
        Math.max(1_000, remainingBudgetMs),
      );
      const output = await createCaption({
        openAIClient,
        model,
        url: attachment.url,
        name: attachment.name?.trim() || "image",
        timeoutMs,
      });
      if (!output) {
        skipped += 1;
        continue;
      }

      const caption = truncateText(output.caption, MAX_CAPTION_CHARS_PER_IMAGE);
      const visibleText = truncateText(
        output.visibleText,
        MAX_VISIBLE_TEXT_CHARS_PER_IMAGE,
      );
      const nowIso = new Date().toISOString();

      const boundedCaption = truncateText(caption, remainingChars);
      remainingChars -= boundedCaption.length;
      const boundedVisibleText = truncateText(visibleText, remainingChars);
      remainingChars -= boundedVisibleText.length;

      const attemptedChars = caption.length + visibleText.length;
      const storedChars = boundedCaption.length + boundedVisibleText.length;
      if (attemptedChars > storedChars) {
        truncatedChars += attemptedChars - storedChars;
      }

      attachment.aiCaption = boundedCaption;
      attachment.aiVisibleText = boundedVisibleText;
      attachment.aiCaptionModel = model;
      attachment.aiCaptionedAt = nowIso;

      captioned += 1;
    } catch (error) {
      skipped += 1;
      console.warn("Failed to caption image attachment, skipping.", {
        meetingId: meeting.meetingId,
        messageId: entry.messageId,
        attachmentId: attachment.id,
        error,
      });
    }
  }

  return {
    candidates: candidates.length,
    captioned,
    skipped,
    truncatedChars,
  };
}
