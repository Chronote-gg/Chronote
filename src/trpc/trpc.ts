import { RuntimeAdmissionUnavailable } from "../services/runtimeAdmissionError";
import { randomUUID } from "node:crypto";
import { runRuntimeApiOperation } from "../services/runtimeApiOperationService";
import { initTRPC, TRPCError } from "@trpc/server";
import type { TrpcContext } from "./context";
import {
  getPermissionReason,
  requireGuildId,
  requireManageGuild,
  PERMISSION_REASONS,
} from "./permissions";
import { ensureUserInGuild } from "../services/guildAccessService";
import { isSuperAdmin } from "../services/adminAccessService";

const t = initTRPC.context<TrpcContext>().create({
  errorFormatter({ shape, error }) {
    const reason = getPermissionReason(error.cause);
    const message =
      error.code === "INTERNAL_SERVER_ERROR"
        ? "Unexpected error. Please try again."
        : shape.message;
    return {
      ...shape,
      message,
      data: {
        ...shape.data,
        reason,
      },
    };
  },
});

const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !ctx.user.accessToken) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const isManageGuild = t.middleware(
  async ({ ctx, input, getRawInput, next }) => {
    if (!ctx.user?.accessToken) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const resolvedInput = input ?? (await getRawInput());
    const guildId = requireGuildId(resolvedInput);
    await requireManageGuild({
      accessToken: ctx.user.accessToken,
      guildId,
      userId: ctx.user.id,
      session: ctx.req.session,
    });
    return next();
  },
);

const isGuildMember = t.middleware(
  async ({ ctx, input, getRawInput, next }) => {
    if (!ctx.user?.accessToken) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    const resolvedInput = input ?? (await getRawInput());
    const guildId = requireGuildId(resolvedInput);
    const allowed = await ensureUserInGuild(ctx.user.accessToken, guildId, {
      session: ctx.req.session,
      userId: ctx.user.id,
    });
    if (allowed === null) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Discord rate limited. Please retry.",
        cause: { reason: PERMISSION_REASONS.discordRateLimited },
      });
    }
    if (!allowed) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Guild membership required",
        cause: { reason: PERMISSION_REASONS.guildMemberRequired },
      });
    }
    return next();
  },
);

const isSuperAdminAccess = t.middleware(({ ctx, next }) => {
  if (!isSuperAdmin(ctx.user?.id)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Super admin access required",
      cause: { reason: PERMISSION_REASONS.superAdminRequired },
    });
  }
  return next();
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const authedProcedure = t.procedure.use(isAuthed);
export const correctionProcedure = authedProcedure.use(
  async ({ next, path }) => {
    try {
      return await runRuntimeApiOperation(
        `api:${path}:${randomUUID()}`,
        (operation) => next({ ctx: { operation } }),
      );
    } catch (error) {
      if (error instanceof RuntimeAdmissionUnavailable)
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "Recording service is switching. Please retry.",
          cause: error,
        });
      throw error;
    }
  },
);
export const manageGuildProcedure = authedProcedure.use(isManageGuild);
export const guildMemberProcedure = authedProcedure.use(isGuildMember);
export const superAdminProcedure = authedProcedure.use(isSuperAdminAccess);
