import { ZodError } from "zod";
import { validateLimits } from "../discordEmbedLayout";
import { PublicationPreviewBlockedError } from "../recoveryDiscordPublicationTypes";
import {
  AnnouncementInputError,
  type Announcement,
  type AnnouncementEmbed,
  type AnnouncementKind,
} from "./announcementTypes";

export const ANNOUNCEMENT_FOOTER_TEXT =
  "Chronote operator notice. Server admins can turn these off in Chronote server settings.";

const DISCORD_EMBED_TOTAL_TEXT_LIMIT = 6000;

const KIND_COLORS: Record<AnnouncementKind, number> = {
  info: 0x5865f2,
  incident: 0xed4245,
  resolved: 0x57f287,
};

const describeLimitError = (error: unknown): string[] => {
  if (error instanceof ZodError) {
    // validateLimits checks an array of embeds; drop the array index.
    return error.issues.map(
      (issue) =>
        `${issue.path.slice(1).map(String).join(".") || "embed"}: ${issue.message}`,
    );
  }
  if (error instanceof PublicationPreviewBlockedError) {
    return [
      `embed: total text exceeds Discord's ${DISCORD_EMBED_TOTAL_TEXT_LIMIT} character limit`,
    ];
  }
  throw error;
};

/** Builds the one embed every server receives; refuses one Discord would reject. */
export const renderAnnouncementEmbed = (
  announcement: Announcement,
  now: Date,
): AnnouncementEmbed => {
  const embed: AnnouncementEmbed = {
    title: announcement.title,
    description: announcement.body,
    color: KIND_COLORS[announcement.kind],
    ...(announcement.fields.length > 0 ? { fields: announcement.fields } : {}),
    footer: { text: ANNOUNCEMENT_FOOTER_TEXT },
    timestamp: now.toISOString(),
  };
  try {
    validateLimits([embed]);
  } catch (error) {
    throw new AnnouncementInputError(describeLimitError(error));
  }
  return embed;
};
