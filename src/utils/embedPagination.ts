import { EmbedBuilder } from "discord.js";

const EMBED_DESCRIPTION_LIMIT = 4096;

function splitTextForEmbeds(
  text: string,
  limit: number = EMBED_DESCRIPTION_LIMIT,
): string[] {
  if (!text) {
    return [""];
  }

  const segments: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf("\n", limit);

    // If no newline found near the boundary, hard split at the limit
    if (splitIndex === -1 || splitIndex < limit * 0.5) {
      splitIndex = limit;
    }

    const part = remaining.slice(0, splitIndex);
    segments.push(part);
    remaining = remaining.slice(splitIndex);
    if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    }
  }

  if (remaining.length > 0 || segments.length === 0) {
    segments.push(remaining);
  }

  return segments;
}

interface BuildEmbedsOptions {
  text: string;
  baseTitle: string;
  footerText?: string;
  color?: number;
  descriptionPrefix?: string;
}

export function buildPaginatedEmbeds({
  text,
  baseTitle,
  footerText,
  color,
  descriptionPrefix = "",
}: BuildEmbedsOptions): EmbedBuilder[] {
  const parts = splitTextForEmbeds(
    text,
    EMBED_DESCRIPTION_LIMIT - descriptionPrefix.length,
  );

  return parts.map((part, index) => {
    const embed = new EmbedBuilder()
      .setDescription(`${descriptionPrefix}${part}` || " ")
      .setTitle(
        parts.length > 1
          ? `${baseTitle} (part ${index + 1}/${parts.length})`
          : baseTitle,
      );

    if (footerText) {
      embed.setFooter({ text: footerText });
    }

    if (color) {
      embed.setColor(color);
    }

    return embed;
  });
}
