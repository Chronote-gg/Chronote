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

export function buildPortalMeetingsUrl(options: {
  baseUrl: string;
  scope: import("../types/meetingBrowse").MeetingBrowseScope;
  meetingServerId?: string;
  meetingId?: string;
  eventId?: string;
  fullScreen?: boolean;
}): string {
  const params = new URLSearchParams({ scope: options.scope.kind });
  if (options.scope.kind === "guild")
    params.set("serverId", options.scope.serverId);
  if (options.meetingServerId && options.meetingId) {
    params.set("meetingServerId", options.meetingServerId);
    params.set("meetingId", options.meetingId);
    if (options.eventId) params.set("eventId", options.eventId);
    if (options.fullScreen) params.set("fullScreen", "true");
  }
  return `${options.baseUrl.replace(/\/$/, "")}/portal/meetings?${params.toString()}`;
}
