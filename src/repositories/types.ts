export type DiscordGuild = {
  id: string;
  name: string;
  icon?: string | null;
  permissions?: string;
  owner?: boolean;
};

export type DiscordPermissionOverwrite = {
  id: string;
  type: number;
  allow: string;
  deny: string;
};

export type DiscordRole = {
  id: string;
  name?: string;
  permissions: string;
};

export type DiscordGuildMember = {
  user?: { id: string; bot?: boolean };
  roles: string[];
  permissions?: string;
};

export type DiscordChannel = {
  id: string;
  name: string;
  type: number;
  position?: number;
  permission_overwrites?: DiscordPermissionOverwrite[];
};
