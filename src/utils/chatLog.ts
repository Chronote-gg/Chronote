import { ChatEntry } from "../types/chat";
import { formatParticipantLabel } from "./participants";

type RenderChatEntryLineOptions = {
  includeAttachmentUrls?: boolean;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function formatAttachmentSummary(
  entry: ChatEntry,
  options: RenderChatEntryLineOptions,
): string | undefined {
  const attachments = entry.attachments;
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const includeAttachmentUrls = options.includeAttachmentUrls === true;
  const limit = 4;
  const shown = attachments.slice(0, limit);
  const extra = attachments.length - shown.length;

  const parts = shown.map((attachment) => {
    const name = attachment.name || "attachment";
    const size = formatBytes(attachment.size);
    const base = `${name} (${size})`;
    return includeAttachmentUrls ? `${base} ${attachment.url}` : base;
  });

  if (extra > 0) {
    parts.push(`+${extra} more`);
  }

  return `attachments: ${parts.join(", ")}`;
}

export function renderChatEntryLine(
  entry: ChatEntry,
  options: RenderChatEntryLineOptions = {},
): string {
  const name = formatParticipantLabel(entry.user, { includeUsername: true });
  const time = new Date(entry.timestamp).toLocaleString();

  if (entry.type === "message") {
    const content = entry.content ?? "";
    const attachmentSummary = formatAttachmentSummary(entry, options);
    if (attachmentSummary) {
      const text = content.trim()
        ? `${content} (${attachmentSummary})`
        : `(${attachmentSummary})`;
      return `[${name} @ ${time}]: ${text}`;
    }
    return `[${name} @ ${time}]: ${content}`;
  }

  const action = entry.type === "join" ? "joined" : "left";
  return `[${name}] ${action} the channel at ${time}`;
}
