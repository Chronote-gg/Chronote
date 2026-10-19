import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  listAutoRecordSettings,
  removeAutoRecordSetting,
  saveAutoRecordSetting,
} from "../../services/autorecordService";
import { manageGuildProcedure, router } from "../trpc";

const list = manageGuildProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ input }) => {
    const rules = await listAutoRecordSettings(input.serverId);
    return { rules };
  });

const add = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      mode: z.enum(["one", "all"]),
      voiceChannelId: z.string().optional(),
      textChannelId: z.string().nullable().optional(),
      tags: z.array(z.string()).optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    if (input.mode === "one" && !input.voiceChannelId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "voiceChannelId required for mode=one",
      });
    }
    const rule = await saveAutoRecordSetting({
      guildId: input.serverId,
      channelId: input.mode === "all" ? "ALL" : input.voiceChannelId!,
      textChannelId: input.textChannelId,
      enabled: true,
      recordAll: input.mode === "all",
      createdBy: ctx.user.id,
      tags: input.tags,
    });
    return { rule };
  });

const remove = manageGuildProcedure
  .input(z.object({ serverId: z.string(), channelId: z.string() }))
  .mutation(async ({ input }) => {
    await removeAutoRecordSetting(input.serverId, input.channelId);
    return { ok: true };
  });

export const autorecordRouter = router({
  list,
  add,
  remove,
});
