const BOT_CLIENT_ID = "1278729036528619633";

export const DISCORD_BOT_INVITE_URL = `https://discord.com/oauth2/authorize?client_id=${BOT_CLIENT_ID}&scope=bot%20applications.commands`;

type UtmParams = {
  source: string;
  medium: string;
  campaign: string;
};

export function buildInviteUrl(utm?: UtmParams): string {
  if (!utm) return DISCORD_BOT_INVITE_URL;
  const params = new URLSearchParams({
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
  });
  return `${DISCORD_BOT_INVITE_URL}&${params.toString()}`;
}

export const JOIN_PAGE_INVITE_URL = buildInviteUrl({
  source: "chronote",
  medium: "web",
  campaign: "join_page",
});
