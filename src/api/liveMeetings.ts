import express from "express";
import { getMeeting } from "../meetings";
import {
  ensureManageGuildWithUserToken,
  ensureUserInGuild,
} from "../services/guildAccessService";
import { ensureUserCanConnectChannel } from "../services/discordPermissionsService";
import {
  buildLiveMeetingMeta,
  resolveLiveMeetingAttendees,
} from "../services/liveMeetingService";
import { buildLiveMeetingTimelineEvents } from "../services/meetingTimelineService";
import type { AuthedProfile } from "../trpc/context";
import type {
  LiveMeetingInitPayload,
  LiveMeetingEventsPayload,
  LiveMeetingAttendeesPayload,
  LiveMeetingStatusPayload,
} from "../types/liveMeeting";
import {
  MEETING_END_REASONS,
  MEETING_STATUS,
  resolveMeetingStatus,
} from "../types/meetingLifecycle";

type SessionGuildCache = {
  guildIds?: string[];
  guildIdsFetchedAt?: number;
};

const GUILD_CACHE_TTL_MS = 60_000;

export function registerLiveMeetingRoutes(app: express.Express) {
  app.get(
    "/api/live/:guildId/:meetingId/status",
    requireAuth,
    async (req, res): Promise<void> => {
      const user = req.user as AuthedProfile;
      const { guildId, meetingId } = req.params;
      const allowed = await ensureManageGuildWithUserToken(
        user.accessToken,
        guildId,
        { userId: user.id, session: req.session },
      );
      if (allowed === null) {
        res.status(429).json({ error: "Discord rate limited. Please retry." });
        return;
      }
      if (!allowed) {
        res.status(403).json({ error: "Manage Server permission required" });
        return;
      }
      const meeting = getMeeting(guildId);
      if (!meeting || meeting.meetingId !== meetingId) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }
      const status = resolveMeetingStatus({
        cancelled: meeting.cancelled,
        finished: meeting.finished,
        finishing: meeting.finishing,
      });
      res.json({
        status,
        endedAt: meeting.endTime?.toISOString(),
        startReason: meeting.startReason,
        startTriggeredByUserId: meeting.startTriggeredByUserId,
        autoRecordRule: meeting.autoRecordRule,
        endReason: meeting.endReason,
        endTriggeredByUserId: meeting.endTriggeredByUserId,
        cancellationReason: meeting.cancellationReason,
      });
    },
  );

  app.post(
    "/api/live/:guildId/:meetingId/end",
    requireAuth,
    async (req, res): Promise<void> => {
      const user = req.user as AuthedProfile;
      const { guildId, meetingId } = req.params;
      const allowed = await ensureManageGuildWithUserToken(
        user.accessToken,
        guildId,
        { userId: user.id, session: req.session },
      );
      if (allowed === null) {
        res.status(429).json({ error: "Discord rate limited. Please retry." });
        return;
      }
      if (!allowed) {
        res.status(403).json({ error: "Manage Server permission required" });
        return;
      }
      const meeting = getMeeting(guildId);
      if (!meeting || meeting.meetingId !== meetingId) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }
      if (meeting.finishing || meeting.finished || meeting.cancelled) {
        res.status(409).json({ error: "Meeting is already ending." });
        return;
      }
      meeting.endReason = MEETING_END_REASONS.WEB_UI;
      meeting.endTriggeredByUserId = user.id;
      if (meeting.onEndMeeting) {
        await meeting.onEndMeeting(meeting);
      } else {
        res.status(500).json({ error: "End meeting handler unavailable" });
        return;
      }
      res.json({ status: "ok" });
    },
  );

  app.get(
    "/api/live/:guildId/:meetingId/stream",
    requireAuth,
    async (req, res): Promise<void> => {
      const user = req.user as AuthedProfile;
      const { guildId, meetingId } = req.params;
      const meeting = getMeeting(guildId);
      if (!meeting || meeting.meetingId !== meetingId) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }
      const sessionData = req.session as typeof req.session & SessionGuildCache;
      const cacheAgeMs =
        sessionData.guildIdsFetchedAt != null
          ? Date.now() - sessionData.guildIdsFetchedAt
          : Number.POSITIVE_INFINITY;
      const cacheFresh = cacheAgeMs < GUILD_CACHE_TTL_MS;
      const cachedGuilds = sessionData.guildIds ?? [];
      const cachedHasGuild = cacheFresh && cachedGuilds.includes(guildId);
      if (!cachedHasGuild) {
        const inGuild = await ensureUserInGuild(user.accessToken, guildId, {
          session: req.session,
          userId: user.id,
        });
        if (inGuild === null) {
          res
            .status(429)
            .json({ error: "Discord rate limited. Please retry." });
          return;
        }
        if (!inGuild) {
          res.status(403).json({ error: "Guild access required" });
          return;
        }
        sessionData.guildIds = Array.from(
          new Set([...(sessionData.guildIds ?? []), guildId]),
        );
        sessionData.guildIdsFetchedAt = Date.now();
      }
      const canConnect = await ensureUserCanConnectChannel({
        guildId,
        channelId: meeting.voiceChannel.id,
        userId: user.id,
      });
      if (canConnect === null) {
        res.status(429).json({ error: "Discord rate limited. Please retry." });
        return;
      }
      if (!canConnect) {
        res.status(403).json({ error: "Channel access required" });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      req.socket.setTimeout(0);

      const seen = new Set<string>();
      let lastAttendeesKey = "";
      let lastStatus: LiveMeetingStatusPayload["status"] | null = null;

      const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const emitEvents = (
        events: ReturnType<typeof buildLiveMeetingTimelineEvents>,
      ) => {
        const fresh = events.filter((event) => {
          if (seen.has(event.id)) return false;
          seen.add(event.id);
          return true;
        });
        if (fresh.length === 0) return;
        const payload: LiveMeetingEventsPayload = { events: fresh };
        sendEvent("events", payload);
      };

      const emitAttendees = () => {
        const attendees = Array.from(meeting.attendance);
        const key = attendees.join("|");
        if (key === lastAttendeesKey) return;
        lastAttendeesKey = key;
        const payload: LiveMeetingAttendeesPayload = {
          attendees: resolveLiveMeetingAttendees(meeting),
        };
        sendEvent("attendees", payload);
      };

      const initPayload: LiveMeetingInitPayload = {
        meeting: buildLiveMeetingMeta(meeting),
        events: [],
      };
      const initialEvents = buildLiveMeetingTimelineEvents(meeting);
      for (const event of initialEvents) {
        seen.add(event.id);
      }
      initPayload.events = initialEvents;
      sendEvent("init", initPayload);
      emitAttendees();
      lastStatus = initPayload.meeting.status;

      const tick = () => {
        emitEvents(buildLiveMeetingTimelineEvents(meeting));
        emitAttendees();
        const nextStatus = resolveMeetingStatus({
          cancelled: meeting.cancelled,
          finished: meeting.finished,
          finishing: meeting.finishing,
        });
        if (nextStatus !== lastStatus) {
          lastStatus = nextStatus;
          const payload: LiveMeetingStatusPayload = {
            status: nextStatus,
            endedAt: meeting.endTime?.toISOString(),
          };
          sendEvent("status", payload);
        }
        if (
          nextStatus === MEETING_STATUS.COMPLETE ||
          nextStatus === MEETING_STATUS.CANCELLED
        ) {
          cleanup();
        }
      };

      const interval = setInterval(tick, 2000);
      const ping = setInterval(() => {
        res.write(": ping\n\n");
      }, 15000);

      const cleanup = () => {
        clearInterval(interval);
        clearInterval(ping);
        res.end();
      };

      req.on("close", cleanup);
    },
  );
}

function requireAuth(
  req: express.Request & { isAuthenticated?: () => boolean },
  res: express.Response,
  next: express.NextFunction,
): void {
  if (req.isAuthenticated?.()) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated" });
}
