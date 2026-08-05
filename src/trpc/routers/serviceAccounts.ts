import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createMcpServiceAccountToken,
  listMcpServiceAccountTokens,
  McpServiceAccountError,
  revokeMcpServiceAccountToken,
} from "../../services/mcpServiceAccountService";
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

export const serviceAccountsRouter = router({
  list: manageGuildProcedure
    .input(guildInput)
    .query(({ input }) => listMcpServiceAccountTokens(input.guildId)),

  // The raw token is returned exactly once here and never stored in readable
  // form, so a lost token has to be revoked and reissued.
  create: manageGuildProcedure
    .input(createInput)
    .mutation(async ({ ctx, input }) => {
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
