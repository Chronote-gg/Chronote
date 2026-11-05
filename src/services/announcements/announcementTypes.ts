import type { DiscordChannel } from "../../repositories/types";

export type AnnouncementKind = "info" | "incident" | "resolved";

export type AnnouncementField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type Announcement = {
  id: string;
  kind: AnnouncementKind;
  title: string;
  body: string;
  fields: AnnouncementField[];
};

export type AnnouncementEmbed = {
  title: string;
  description: string;
  color: number;
  fields?: AnnouncementField[];
  footer: { text: string };
  timestamp: string;
};

const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/** True when the value is shaped like a Discord snowflake id. */
export const isSnowflake = (value: unknown): value is string =>
  typeof value === "string" && SNOWFLAKE_PATTERN.test(value);

export type ChannelSource = "public_updates" | "notes" | "system" | "owner_dm";

export type RequiredPermissionName =
  "ViewChannel" | "SendMessages" | "EmbedLinks";

export type CandidateRejection = {
  source: ChannelSource;
  channelId: string;
  problem: "missing" | "not_text" | "duplicate" | "missing_permissions";
  missing?: RequiredPermissionName[];
};

export type GuildSnapshot = {
  guildId: string;
  guildName: string;
  ownerId: string;
  roles: { id: string; permissions?: string | null }[];
  botRoleIds: string[];
  publicUpdatesChannelId: string | null;
  systemChannelId: string | null;
  notesChannelId: string | null;
  channels: DiscordChannel[];
};

export type TargetDecision =
  | {
      kind: "target";
      channelId: string;
      channelSource: Exclude<ChannelSource, "owner_dm">;
      rejected: CandidateRejection[];
    }
  | {
      kind: "owner_dm";
      ownerId: string;
      guildName: string;
      updatesChannelId: string;
      missing: RequiredPermissionName[];
      rejected: CandidateRejection[];
    }
  | {
      kind: "skip";
      reason: "opted_out" | "no_channel" | "missing_permissions";
      rejected: CandidateRejection[];
    };

/** An announcement that must not be previewed or sent, with every reason. */
export class AnnouncementInputError extends Error {
  constructor(readonly problems: string[]) {
    super(`Announcement input is invalid: ${problems.join("; ")}`);
    this.name = "AnnouncementInputError";
  }
}
