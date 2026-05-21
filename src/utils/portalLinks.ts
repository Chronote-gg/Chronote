export function buildPortalMeetingUrl(options: {
  baseUrl: string;
  guildId: string;
  meetingId: string;
  eventId?: string;
  fullScreen?: boolean;
}) {
  const { baseUrl, guildId, meetingId, eventId, fullScreen } = options;
  const params = new URLSearchParams();
  if (eventId) {
    params.set("eventId", eventId);
  }
  if (fullScreen) {
    params.set("fullScreen", "true");
  }
  const query = params.toString();
  const path = `/portal/meetings/${encodeURIComponent(
    guildId,
  )}/${encodeURIComponent(meetingId)}${query ? `?${query}` : ""}`;
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}${path}`;
}
