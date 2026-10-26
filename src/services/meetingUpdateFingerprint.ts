import {
  publicationMessageFingerprint,
  digest,
  normalizePublicationEmbeds,
} from "./recoveryDiscordPublicationTypes";
import type { DiscordEditorMessage } from "./discordMessageEditor";
import { MeetingUpdatePlanBlocked } from "./meetingUpdatePlanTypes";

export const meetingUpdateMessageFingerprint = publicationMessageFingerprint;

// Creation fingerprints bind the destination and editable content, never a not-yet-known ID.
export function meetingUpdateCreationFingerprint(input: {
  channelId: string;
  botId: string;
  embeds: Record<string, unknown>[];
}): string {
  return digest({
    channel_id: input.channelId,
    author: { id: input.botId, bot: true },
    content: "",
    embeds: normalizePublicationEmbeds(input.embeds),
    components: [],
    attachments: [],
    flags: 0,
  });
}
export function observedMeetingUpdateCreationFingerprint(
  message: DiscordEditorMessage,
): string {
  if (
    message.content !== "" ||
    message.components.length ||
    message.attachments.length ||
    message.flags !== 0 ||
    message.webhook_id ||
    !message.author.bot
  )
    throw new MeetingUpdatePlanBlocked("protected_creation");
  return meetingUpdateCreationFingerprint({
    channelId: message.channel_id,
    botId: message.author.id,
    embeds: message.embeds,
  });
}
