import { z } from "zod";
import { getFirstMeetingState } from "../../services/firstMeetingService";
import { guildMemberProcedure } from "../trpc";
import { requireBotInGuild } from "./ensureBotPresence";

export const firstMeeting = guildMemberProcedure
  .input(
    z.object({
      serverId: z.string().regex(/^\d{17,20}$/),
      historyId: z
        .string()
        .regex(/^\d{17,20}#.+$/)
        .optional(),
    }),
  )
  .query(async ({ ctx, input }) => {
    await requireBotInGuild(input.serverId);
    return getFirstMeetingState({
      guildId: input.serverId,
      userId: ctx.user.id,
      historyId: input.historyId,
    });
  });
