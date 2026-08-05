import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMcpServiceAccountToken,
  listMcpServiceAccountTokens,
  McpServiceAccountError,
  revokeMcpServiceAccountToken,
} from "../../services/mcpServiceAccountService";
import {
  ensureGuildAdministratorWithUserToken,
  type GuildSessionCache,
} from "../../services/guildAccessService";
import {
  MCP_SERVICE_ACCOUNT_MAX_CHANNEL_IDS,
  MCP_SERVICE_ACCOUNT_MAX_EXPIRY_DAYS,
  MCP_SERVICE_ACCOUNT_NAME_MAX_LENGTH,
  MCP_SERVICE_ACCOUNT_SCOPES,
} from "../../types/mcpServiceAccount";
import { manageGuildProcedure, router } from "../trpc";

const snowflake = z.string().regex(/^\d{17,20}$/, "Expected a Discord id.");

const guildInput = z.object({ guildId: snowflake });

const createInput = guildInput.extend({
  botUserId: snowflake,
  name: z.string().trim().min(1).max(MCP_SERVICE_ACCOUNT_NAME_MAX_LENGTH),
  scopes: z.array(z.enum(MCP_SERVICE_ACCOUNT_SCOPES)).min(1),
  channelIds: z
    .array(snowflake)
    .max(MCP_SERVICE_ACCOUNT_MAX_CHANNEL_IDS)
    .optional(),
  expiresInDays: z
    .number()
    .int()
    .min(1)
    .max(MCP_SERVICE_ACCOUNT_MAX_EXPIRY_DAYS)
    .optional(),
});

const revokeInput = guildInput.extend({ tokenId: z.string().uuid() });

const SERVICE_ACCOUNT_ERROR_CODES = {
  bot_not_in_guild: "BAD_REQUEST",
  not_a_bot: "BAD_REQUEST",
  administrator_bot: "BAD_REQUEST",
  unknown_channel: "BAD_REQUEST",
  rate_limited: "TOO_MANY_REQUESTS",
  not_found: "NOT_FOUND",
} as const;

const toTrpcError = (error: unknown) => {
  if (!(error instanceof McpServiceAccountError)) return error;
  return new TRPCError({
    code: SERVICE_ACCOUNT_ERROR_CODES[error.code],
    message: error.message,
  });
};

/**
 * Minting needs more than the Manage Server permission the other procedures
 * take. Manage Server does not grant access to any particular channel, so a
 * manager denied a private channel could otherwise bind a token to a bot that
 * can see it and read those meetings as the bot. Administrator already reaches
 * every channel, so it cannot delegate more than it holds.
 */
const assertGuildAdministrator = async (params: {
  accessToken?: string;
  guildId: string;
  userId: string;
  session?: GuildSessionCache;
}) => {
  const allowed = await ensureGuildAdministratorWithUserToken(
    params.accessToken,
    params.guildId,
    { userId: params.userId, session: params.session },
  );
  if (allowed === null) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Discord rate limited. Please retry.",
    });
  }
  if (!allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Creating a service account requires Administrator in this server.",
    });
  }
};

export const serviceAccountsRouter = router({
  // `canCreate` rides along because minting needs Administrator while listing
  // only needs Manage Server, and the guild list the portal already holds does
  // not carry permissions. Returning it here keeps that out of a second call.
  list: manageGuildProcedure
    .input(guildInput)
    .query(async ({ ctx, input }) => ({
      serviceAccounts: await listMcpServiceAccountTokens(input.guildId),
      canCreate:
        (await ensureGuildAdministratorWithUserToken(
          ctx.user.accessToken,
          input.guildId,
          { userId: ctx.user.id, session: ctx.req.session },
        )) === true,
    })),

  // The raw token is returned exactly once here and never stored in readable
  // form, so a lost token has to be revoked and reissued.
  create: manageGuildProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
      await assertGuildAdministrator({
        accessToken: ctx.user.accessToken,
        guildId: input.guildId,
        userId: ctx.user.id,
        session: ctx.req.session,
      });
      try {
        return await createMcpServiceAccountToken({
          guildId: input.guildId,
          botUserId: input.botUserId,
          name: input.name,
          scopes: input.scopes,
          channelIds: input.channelIds,
          expiresInDays: input.expiresInDays,
          createdByUserId: ctx.user.id,
        });
      } catch (error) {
        throw toTrpcError(error);
      }
    }),

  revoke: manageGuildProcedure
    .input(revokeInput)
    .mutation(async ({ input }) => {
      try {
        await revokeMcpServiceAccountToken(input);
        return { revoked: true };
      } catch (error) {
        throw toTrpcError(error);
      }
    }),
});
