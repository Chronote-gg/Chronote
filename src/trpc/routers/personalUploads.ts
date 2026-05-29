import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES,
  PERSONAL_MEDIA_UPLOAD_MAX_BYTES,
  PERSONAL_MEDIA_UPLOAD_RATE_LIMIT_MAX,
  PERSONAL_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
} from "../../constants";
import {
  createPersonalMediaUploadIntent,
  getPersonalMediaUploadJobForUser,
  markPersonalMediaUploadComplete,
  PersonalMediaUploadError,
} from "../../services/personalMediaUploadService";
import { createRateLimitMiddleware } from "../rateLimitMiddleware";
import { authedProcedure, router } from "../trpc";

const uploadIntentRateLimited = createRateLimitMiddleware(
  "personal-media-upload-intent",
  PERSONAL_MEDIA_UPLOAD_RATE_LIMIT_WINDOW_MS,
  PERSONAL_MEDIA_UPLOAD_RATE_LIMIT_MAX,
);

const createUploadIntent = authedProcedure
  .use(uploadIntentRateLimited)
  .input(
    z.object({
      contentType: z.enum(
        PERSONAL_MEDIA_UPLOAD_ALLOWED_CONTENT_TYPES as [string, ...string[]],
      ),
      fileSize: z.number().int().min(1).max(PERSONAL_MEDIA_UPLOAD_MAX_BYTES),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    try {
      return await createPersonalMediaUploadIntent({
        userId: ctx.user.id,
        contentType: input.contentType,
        fileSize: input.fileSize,
      });
    } catch (error) {
      if (error instanceof PersonalMediaUploadError) {
        if (error.code === "unsupported_type" || error.code === "too_large") {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to create upload form.",
        });
      }
      throw error;
    }
  });

const mapUploadError = (error: PersonalMediaUploadError): TRPCError => {
  if (error.code === "not_found" || error.code === "forbidden") {
    return new TRPCError({ code: "NOT_FOUND", message: "Upload not found." });
  }
  if (
    error.code === "unsupported_type" ||
    error.code === "too_large" ||
    error.code === "expired" ||
    error.code === "invalid_token" ||
    error.code === "missing_object" ||
    error.code === "invalid_state"
  ) {
    return new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Failed to process upload.",
  });
};

const completeUpload = authedProcedure
  .input(
    z.object({
      uploadId: z.string().uuid(),
      key: z.string().min(1).max(1024),
      uploadToken: z.string().min(1).max(512),
      originalFileName: z.string().min(1).max(255).optional(),
      title: z.string().min(1).max(100).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    try {
      const job = await markPersonalMediaUploadComplete({
        uploadId: input.uploadId,
        userId: ctx.user.id,
        key: input.key,
        uploadToken: input.uploadToken,
        originalFileName: input.originalFileName,
        title: input.title,
        tags: input.tags,
      });
      return { job };
    } catch (error) {
      if (error instanceof PersonalMediaUploadError)
        throw mapUploadError(error);
      throw error;
    }
  });

const getStatus = authedProcedure
  .input(z.object({ uploadId: z.string().uuid() }))
  .query(async ({ ctx, input }) => {
    try {
      return {
        job: await getPersonalMediaUploadJobForUser({
          uploadId: input.uploadId,
          userId: ctx.user.id,
        }),
      };
    } catch (error) {
      if (error instanceof PersonalMediaUploadError)
        throw mapUploadError(error);
      throw error;
    }
  });

export const personalUploadsRouter = router({
  createUploadIntent,
  completeUpload,
  getStatus,
});
