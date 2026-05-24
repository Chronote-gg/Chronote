export type PortalMeetingLink = {
  serverId: string;
  meetingId: string;
  eventId?: string;
  fullScreen?: boolean;
};

const directMeetingPath = /^\/portal\/meetings\/([^/]+)\/([^/]+)$/;
const legacyPortalServerPath = /^\/portal\/server\/([^/]+)\//;

const resolveFullScreenParam = (value: string | null) =>
  value === "true" || value === "1" ? true : undefined;

const decodePathSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const resolveDirectMeetingLink = (url: URL): PortalMeetingLink | null => {
  const match = url.pathname.match(directMeetingPath);
  if (!match) return null;
  const serverId = decodePathSegment(match[1]);
  const meetingId = decodePathSegment(match[2]);
  if (!serverId || !meetingId) return null;
  return {
    serverId,
    meetingId,
    eventId: url.searchParams.get("eventId") ?? undefined,
    fullScreen: resolveFullScreenParam(url.searchParams.get("fullScreen")),
  };
};

export const parsePortalMeetingLink = (
  href: string,
  origin: string,
): PortalMeetingLink | null => {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  const direct = resolveDirectMeetingLink(url);
  if (direct) return direct;

  const meetingId = url.searchParams.get("meetingId");
  if (!meetingId) return null;
  const match = url.pathname.match(legacyPortalServerPath);
  if (!match) return null;
  const serverId = match[1];
  const eventId = url.searchParams.get("eventId") ?? undefined;
  const fullScreen = resolveFullScreenParam(url.searchParams.get("fullScreen"));
  return { serverId, meetingId, eventId, fullScreen };
};

export const buildMeetingLinkForLocation = (options: {
  pathname: string;
  search: string;
  meetingId: string;
  eventId?: string;
  fullScreen?: boolean;
}) => {
  const params = new URLSearchParams(options.search);
  params.set("meetingId", options.meetingId);
  if (options.eventId) {
    params.set("eventId", options.eventId);
  } else {
    params.delete("eventId");
  }
  if (options.fullScreen) {
    params.set("fullScreen", "true");
  } else {
    params.delete("fullScreen");
  }
  const query = params.toString();
  return `${options.pathname}${query ? `?${query}` : ""}`;
};
