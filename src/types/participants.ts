export interface Participant {
  id: string; // Discord user snowflake
  username: string; // Discord username
  displayName?: string; // Discord global display name
  serverNickname?: string; // guild nickname
  tag?: string; // legacy username#discriminator (or new global tag)
  roleIds?: string[]; // guild roles held at meeting time, excluding @everyone
}
