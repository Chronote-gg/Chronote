import { z } from "zod";
import { superAdminProcedure, router } from "../trpc";
import { listFeedbackEntries } from "../../services/adminFeedbackService";
import { listBotGuildsCached } from "../../services/discordCacheService";

const targetTypeSchema = z.enum(["meeting_summary", "ask_answer"]);
const ratingSchema = z.enum(["up", "down"]);
const sourceSchema = z.enum(["discord", "web"]);

const resolveGuildsById = async (guildIds: Set<string>) => {
  if (guildIds.size === 0) return {};
  try {
    const guilds = await listBotGuildsCached();
    return Object.fromEntries(
      guilds
        .filter((guild) => guildIds.has(guild.id))
        .map((guild) => [guild.id, guild.name]),
    );
  } catch (error) {
    console.error("Unable to resolve guild names for admin feedback.", error);
    return {};
  }
};

const list = superAdminProcedure
  .input(
    z.object({
      targetType: targetTypeSchema.optional(),
      rating: ratingSchema.optional(),
      source: sourceSchema.optional(),
      limit: z.number().min(1).max(200).optional(),
      cursor: z.string().optional(),
    }),
  )
  .query(async ({ input }) => {
    const result = await listFeedbackEntries({
      targetType: input.targetType,
      rating: input.rating,
      source: input.source,
      limit: input.limit,
      cursor: input.cursor,
    });

    const guildIds = new Set(
      result.items.map((item) => item.guildId).filter(Boolean),
    );
    const guildsById = await resolveGuildsById(guildIds);

    return { items: result.items, nextCursor: result.nextCursor, guildsById };
  });

export const adminFeedbackRouter = router({
  list,
});
