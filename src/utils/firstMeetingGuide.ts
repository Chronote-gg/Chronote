import { escapeMarkdown } from "@discordjs/formatters";
import { ButtonStyle, ComponentType } from "discord-api-types/v10";
import type { BaseMessageOptions } from "discord.js";

const MAX_BUTTON_LABEL_LENGTH = 80;

export function buildFirstMeetingInstallerMessage(options: {
  guildId: string;
  serverName: string;
  siteUrl: string;
}): BaseMessageOptions {
  const { guildId, serverName, siteUrl } = options;
  const base = siteUrl.replace(/\/$/, "");
  const serverId = encodeURIComponent(guildId);
  const serverLabel = `Open ${serverName}`
    .slice(0, MAX_BUTTON_LABEL_LENGTH)
    .replace(/[\uD800-\uDBFF]$/u, "");
  return {
    content: [
      `Thanks for adding Chronote to **${escapeMarkdown(serverName)}**.`,
      "",
      "Here's how to get your first notes:",
      "",
      "1. Join a voice channel.",
      "2. Run `/startmeeting` in a text channel.",
      "3. Follow the private link to your recording. Press **End meeting** when you're done.",
      "",
      "Your notes will be posted with the recording and saved in your meeting library.",
    ].join("\n"),
    allowedMentions: { parse: [] },
    components: [
      {
        type: ComponentType.ActionRow,
        components: [
          {
            type: ComponentType.Button,
            label: "Open portal",
            style: ButtonStyle.Link,
            url: `${base}/portal/meetings?scope=guild&serverId=${serverId}`,
          },
          {
            type: ComponentType.Button,
            label: serverLabel,
            style: ButtonStyle.Link,
            url: `https://discord.com/channels/${serverId}`,
          },
        ],
      },
    ],
  };
}
