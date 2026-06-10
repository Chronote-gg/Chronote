import { z } from "zod";
import {
  clearChannelContext,
  listChannelContexts,
  setChannelContext,
} from "../../services/channelContextService";
import { ensureBotPresence } from "./ensureBotPresence";
import { manageGuildProcedure, router } from "../trpc";

const list = manageGuildProcedure
  .input(z.object({ serverId: z.string() }))
  .query(async ({ ctx, input }) => {
    await ensureBotPresence(ctx, input.serverId);
    const contexts = await listChannelContexts(input.serverId);
    return { contexts };
  });

const set = manageGuildProcedure
  .input(
    z.object({
      serverId: z.string(),
      channelId: z.string(),
      context: z.string().optional(),
      defaultNotesChannelId: z.string().nullable().optional(),
      liveVoiceEnabled: z.boolean().optional().nullable(),
      liveVoiceCommandsEnabled: z.boolean().optional().nullable(),
      chatTtsEnabled: z.boolean().optional().nullable(),
      chatTtsTtsOnlyEnabled: z.boolean().optional().nullable(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    await ensureBotPresence(ctx, input.serverId);
    const trimmedContext = input.context?.trim();
    await setChannelContext(input.serverId, input.channelId, ctx.user.id, {
      context: trimmedContext ? trimmedContext : null,
      defaultNotesChannelId:
        input.defaultNotesChannelId === undefined
          ? undefined
          : input.defaultNotesChannelId,
      liveVoiceEnabled:
        input.liveVoiceEnabled === undefined
          ? undefined
          : input.liveVoiceEnabled,
      liveVoiceCommandsEnabled:
        input.liveVoiceCommandsEnabled === undefined
          ? undefined
          : input.liveVoiceCommandsEnabled,
      chatTtsEnabled:
        input.chatTtsEnabled === undefined ? undefined : input.chatTtsEnabled,
      chatTtsTtsOnlyEnabled:
        input.chatTtsTtsOnlyEnabled === undefined
          ? undefined
          : input.chatTtsTtsOnlyEnabled,
    });
    return { ok: true };
  });

const clear = manageGuildProcedure
  .input(z.object({ serverId: z.string(), channelId: z.string() }))
  .mutation(async ({ ctx, input }) => {
    await ensureBotPresence(ctx, input.serverId);
    await clearChannelContext(input.serverId, input.channelId);
    return { ok: true };
  });

export const channelContextsRouter = router({
  list,
  set,
  clear,
});
