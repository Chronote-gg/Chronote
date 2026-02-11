import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { CONFIG_KEYS } from "../../config/keys";
import {
  getSnapshotEnum,
  resolveConfigSnapshot,
} from "../../services/unifiedConfigService";
import { getMeetingHistoryService } from "../../services/meetingHistoryService";
import {
  ensureManageGuildWithUserToken,
  type GuildSessionCache,
} from "../../services/guildAccessService";
import {
  ensureUserCanManageChannel,
  ensureUserCanViewChannel,
} from "../../services/discordPermissionsService";
import { buildSharedMeetingPayloadService } from "../../services/meetingSharePayloadService";
import {
  getMeetingShareRecordByShareIdService,
  getMeetingShareStateForMeetingService,
  setMeetingShareVisibilityService,
  type MeetingShareVisibilityInput,
} from "../../services/meetingShareService";
import { guildMemberProcedure, publicProcedure, router } from "../trpc";

type MeetingSharePolicy = "off" | "server" | "public";

const resolveMeetingSharePolicy = async (guildId: string) => {
  const snapshot = await resolveConfigSnapshot({ guildId });
  const meetingSharingPolicy =
    getSnapshotEnum(snapshot, CONFIG_KEYS.meetings.sharingPolicy, [
      "off",
      "server",
      "public",
    ]) ?? "server";
  return { meetingSharingPolicy };
};

const ensureSharingAllowed = (
  policy: MeetingSharePolicy,
  visibility: MeetingShareVisibilityInput,
) => {
  if (visibility === "private") return;
  if (policy === "off") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Sharing is disabled for this server",
    });
  }
  if (visibility === "public" && policy !== "public") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Public sharing is disabled for this server",
    });
  }
};

const resolveMeetingChannelId = (history: {
  channelId?: string;
  channelId_timestamp: string;
}) => history.channelId ?? history.channelId_timestamp.split("#")[0] ?? "";

const setNoStoreHeaders = (ctx: {
  res: { setHeader: (key: string, value: string) => void };
}) => {
  ctx.res.setHeader("Cache-Control", "no-store");
};

const buildRequesterTag = (user: {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
}) => {
  const username = user.username ?? user.id ?? "unknown";
  const discriminator = user.discriminator;
  if (discriminator && discriminator !== "0") {
    return `${username}#${discriminator}`;
  }
  return username;
};

const ensureUserCanShareMeeting = async (options: {
  accessToken: string;
  guildId: string;
  meeting: NonNullable<Awaited<ReturnType<typeof getMeetingHistoryService>>>;
  userId: string;
  session?: GuildSessionCache;
}) => {
  const manageGuild = await ensureManageGuildWithUserToken(
    options.accessToken,
    options.guildId,
    { userId: options.userId, session: options.session },
  );
  if (manageGuild === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (manageGuild === true) {
    return;
  }

  if (!options.meeting.meetingCreatorId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Manage Server permission required for this meeting",
    });
  }

  if (options.meeting.meetingCreatorId === options.userId) {
    return;
  }

  if (options.meeting.isAutoRecording) {
    const channelId = resolveMeetingChannelId(options.meeting);
    const allowed = await ensureUserCanManageChannel({
      guildId: options.guildId,
      channelId,
      userId: options.userId,
    });
    if (allowed === null) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Discord rate limited. Please retry.",
      });
    }
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Manage channel permission required",
      });
    }
    return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Only the meeting starter can share this meeting",
  });
};

const settings = guildMemberProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    return resolveMeetingSharePolicy(input.serverId);
  });

const getShareState = guildMemberProcedure
  .input(z.object({ serverId: z.string(), meetingId: z.string() }))
  .query(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    const { meetingSharingPolicy } = await resolveMeetingSharePolicy(
      input.serverId,
    );
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    await ensureUserCanShareMeeting({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      meeting: history,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    const state = await getMeetingShareStateForMeetingService({
      guildId: input.serverId,
      meetingId: input.meetingId,
    });
    return { meetingSharingPolicy, state };
  });

const setVisibility = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string(),
      meetingId: z.string(),
      visibility: z.enum(["private", "server", "public"]),
      acknowledgePublic: z.boolean().optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    const { meetingSharingPolicy } = await resolveMeetingSharePolicy(
      input.serverId,
    );
    ensureSharingAllowed(meetingSharingPolicy, input.visibility);
    if (input.visibility === "public" && input.acknowledgePublic !== true) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Public sharing acknowledgment required",
      });
    }
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    await ensureUserCanShareMeeting({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      meeting: history,
      userId: ctx.user.id,
      session: ctx.req.session,
    });

    const next = await setMeetingShareVisibilityService({
      guildId: input.serverId,
      meetingId: input.meetingId,
      visibility: input.visibility,
      sharedByUserId: ctx.user.id,
      sharedByTag: buildRequesterTag(ctx.user),
    });

    return { meetingSharingPolicy, state: next };
  });

const rotate = guildMemberProcedure
  .input(z.object({ serverId: z.string(), meetingId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    const { meetingSharingPolicy } = await resolveMeetingSharePolicy(
      input.serverId,
    );
    if (meetingSharingPolicy === "off") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Sharing is disabled for this server",
      });
    }
    const history = await getMeetingHistoryService(
      input.serverId,
      input.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    await ensureUserCanShareMeeting({
      accessToken: ctx.user.accessToken ?? "",
      guildId: input.serverId,
      meeting: history,
      userId: ctx.user.id,
      session: ctx.req.session,
    });

    const current = await getMeetingShareStateForMeetingService({
      guildId: input.serverId,
      meetingId: input.meetingId,
    });
    if (current.visibility === "private") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Meeting is not currently shared",
      });
    }
    const effectiveVisibility: MeetingShareVisibilityInput =
      meetingSharingPolicy === "public" ? current.visibility : "server";
    ensureSharingAllowed(meetingSharingPolicy, effectiveVisibility);

    const next = await setMeetingShareVisibilityService({
      guildId: input.serverId,
      meetingId: input.meetingId,
      visibility: effectiveVisibility,
      sharedByUserId: ctx.user.id,
      sharedByTag: buildRequesterTag(ctx.user),
      forceRotate: true,
    });

    return { meetingSharingPolicy, state: next };
  });

const getSharedMeeting = guildMemberProcedure
  .input(z.object({ serverId: z.string(), shareId: z.string() }))
  .query(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    const { meetingSharingPolicy } = await resolveMeetingSharePolicy(
      input.serverId,
    );
    if (meetingSharingPolicy === "off") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    const share = await getMeetingShareRecordByShareIdService({
      guildId: input.serverId,
      shareId: input.shareId,
    });
    if (!share) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }

    const history = await getMeetingHistoryService(
      input.serverId,
      share.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    const channelId = resolveMeetingChannelId(history);
    const allowed = await ensureUserCanViewChannel({
      guildId: input.serverId,
      channelId,
      userId: ctx.user.id,
    });
    if (allowed === null) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Discord rate limited. Please retry.",
      });
    }
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Channel access required",
      });
    }

    const payload = await buildSharedMeetingPayloadService(history);
    return {
      ...payload,
      share: {
        shareId: share.shareId,
        visibility: share.visibility,
        sharedAt: share.sharedAt,
        sharedByTag: share.sharedByTag,
      },
    };
  });

const getPublicMeeting = publicProcedure
  .input(z.object({ serverId: z.string(), shareId: z.string() }))
  .query(async ({ ctx, input }) => {
    setNoStoreHeaders(ctx);
    const { meetingSharingPolicy } = await resolveMeetingSharePolicy(
      input.serverId,
    );
    if (meetingSharingPolicy !== "public") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    const share = await getMeetingShareRecordByShareIdService({
      guildId: input.serverId,
      shareId: input.shareId,
    });
    if (!share || share.visibility !== "public") {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    const history = await getMeetingHistoryService(
      input.serverId,
      share.meetingId,
    );
    if (!history) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Meeting not found" });
    }
    const payload = await buildSharedMeetingPayloadService(history);
    return {
      ...payload,
      share: {
        shareId: share.shareId,
        visibility: share.visibility,
        sharedAt: share.sharedAt,
        sharedByTag: share.sharedByTag,
      },
    };
  });

export const meetingSharesRouter = router({
  settings,
  getShareState,
  setVisibility,
  rotate,
  getSharedMeeting,
  getPublicMeeting,
});
