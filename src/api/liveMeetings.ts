import express from "express";
import { getMeeting } from "../meetings";
import {
  getActiveMeetingLeaseForGuild,
  isLeaseActive,
  requestMeetingEndViaLease,
} from "../services/activeMeetingLeaseService";
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
import type { ActiveMeetingLease } from "../types/db";
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
const REMOTE_LEASE_REFRESH_MS = 10_000;

function resolveRemoteLeaseStatus(
  lease: ActiveMeetingLease,
): LiveMeetingStatusPayload["status"] {
  if (!isLeaseActive(lease)) {
    if (lease.status === MEETING_STATUS.CANCELLED) {
      return MEETING_STATUS.CANCELLED;
    }
    if (lease.status === MEETING_STATUS.COMPLETE) {
      return MEETING_STATUS.COMPLETE;
    }
    return MEETING_STATUS.COMPLETE;
  }

  return lease.status ?? MEETING_STATUS.IN_PROGRESS;
}

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
        const lease = await getActiveMeetingLeaseForGuild(guildId);
        if (!lease || lease.meetingId !== meetingId) {
          res.status(404).json({ error: "Meeting not found" });
          return;
        }
        res.json({
          status: resolveRemoteLeaseStatus(lease),
          endedAt: lease.endedAt,
          startReason: lease.startReason,
          startTriggeredByUserId: lease.startTriggeredByUserId,
          autoRecordRule: lease.autoRecordRule,
          endReason: lease.endReason,
          endTriggeredByUserId:
            lease.endTriggeredByUserId ?? lease.endRequestedByUserId,
          cancellationReason: lease.cancellationReason,
        });
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
        const lease = await getActiveMeetingLeaseForGuild(guildId);
        if (!lease || lease.meetingId !== meetingId || !isLeaseActive(lease)) {
          res.status(404).json({ error: "Meeting not found" });
          return;
        }
        const queued = await requestMeetingEndViaLease(
          guildId,
          meetingId,
          user.id,
        );
        if (!queued) {
          res.status(409).json({ error: "Meeting end request was rejected." });
          return;
        }
        res.json({ status: "accepted" });
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
      const localMeeting = getMeeting(guildId);
      const meeting =
        localMeeting && localMeeting.meetingId === meetingId
          ? localMeeting
          : undefined;
      const fallbackLease = meeting
        ? undefined
        : await getActiveMeetingLeaseForGuild(guildId);
      if (
        !meeting &&
        (!fallbackLease || fallbackLease.meetingId !== meetingId)
      ) {
        res.status(404).json({ error: "Meeting not found" });
        return;
      }
      const targetVoiceChannelId = meeting
        ? meeting.voiceChannel.id
        : fallbackLease!.voiceChannelId;
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
        channelId: targetVoiceChannelId,
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
      let cachedRemoteLease = fallbackLease;
      let nextRemoteLeaseReadAtMs = Date.now();

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
        if (!meeting) {
          const payload: LiveMeetingAttendeesPayload = { attendees: [] };
          sendEvent("attendees", payload);
          return;
        }
        const attendees = Array.from(meeting.attendance);
        const key = attendees.join("|");
        if (key === lastAttendeesKey) return;
        lastAttendeesKey = key;
        const payload: LiveMeetingAttendeesPayload = {
          attendees: resolveLiveMeetingAttendees(meeting),
        };
        sendEvent("attendees", payload);
      };

      const initPayload: LiveMeetingInitPayload = meeting
        ? {
            meeting: buildLiveMeetingMeta(meeting),
            events: [],
          }
        : {
            meeting: {
              guildId,
              meetingId,
              channelId: fallbackLease!.voiceChannelId,
              channelName: fallbackLease!.voiceChannelName ?? "Voice Channel",
              startedAt: fallbackLease!.createdAt,
              isAutoRecording: fallbackLease!.isAutoRecording,
              status: resolveRemoteLeaseStatus(fallbackLease!),
              attendees: [],
            },
            events: [],
          };
      if (meeting) {
        const initialEvents = buildLiveMeetingTimelineEvents(meeting);
        for (const event of initialEvents) {
          seen.add(event.id);
        }
        initPayload.events = initialEvents;
      }
      sendEvent("init", initPayload);
      emitAttendees();
      lastStatus = initPayload.meeting.status;

      const resolveRemoteMeetingStatus = async () => {
        if (Date.now() >= nextRemoteLeaseReadAtMs) {
          cachedRemoteLease = await getActiveMeetingLeaseForGuild(guildId);
          nextRemoteLeaseReadAtMs = Date.now() + REMOTE_LEASE_REFRESH_MS;
        }
        const active =
          cachedRemoteLease &&
          cachedRemoteLease.meetingId === meetingId &&
          isLeaseActive(cachedRemoteLease);

        if (active && cachedRemoteLease) {
          const leaseRemainingMs =
            cachedRemoteLease.leaseExpiresAt * 1000 - Date.now();
          if (leaseRemainingMs <= REMOTE_LEASE_REFRESH_MS) {
            nextRemoteLeaseReadAtMs = Date.now();
          }
        }

        if (!cachedRemoteLease || cachedRemoteLease.meetingId !== meetingId) {
          return MEETING_STATUS.COMPLETE;
        }
        return resolveRemoteLeaseStatus(cachedRemoteLease);
      };

      const tick = async () => {
        try {
          if (meeting) {
            emitEvents(buildLiveMeetingTimelineEvents(meeting));
            emitAttendees();
          }

          let nextStatus: LiveMeetingStatusPayload["status"];
          let endedAt: string | undefined;
          if (meeting) {
            nextStatus = resolveMeetingStatus({
              cancelled: meeting.cancelled,
              finished: meeting.finished,
              finishing: meeting.finishing,
            });
            endedAt = meeting.endTime?.toISOString();
          } else {
            nextStatus = await resolveRemoteMeetingStatus();
          }

          if (nextStatus !== lastStatus) {
            lastStatus = nextStatus;
            const payload: LiveMeetingStatusPayload = {
              status: nextStatus,
              endedAt,
            };
            sendEvent("status", payload);
          }
          if (
            nextStatus === MEETING_STATUS.COMPLETE ||
            nextStatus === MEETING_STATUS.CANCELLED
          ) {
            cleanup();
          }
        } catch (error) {
          console.error("Live meeting stream tick failed", {
            guildId,
            meetingId,
            error,
          });
        }
      };

      let tickInProgress = false;

      const runTick = async () => {
        if (tickInProgress) {
          return;
        }
        tickInProgress = true;
        try {
          await tick();
        } finally {
          tickInProgress = false;
        }
      };

      const interval = setInterval(() => {
        void runTick();
      }, 2000);
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
