import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router, superAdminProcedure } from "../trpc";
import {
  submitContactFeedback,
  listContactFeedbackEntries,
} from "../../services/contactFeedbackService";
import {
  CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH,
  CONTACT_FEEDBACK_MAX_IMAGES,
  CONTACT_FEEDBACK_MAX_IMAGE_BYTES,
  CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES,
  CONTACT_FEEDBACK_S3_PREFIX,
  CONTACT_FEEDBACK_RATE_LIMIT_WINDOW_MS,
  CONTACT_FEEDBACK_RATE_LIMIT_MAX,
  CONTACT_FEEDBACK_UPLOAD_URL_RATE_LIMIT_MAX,
  CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
} from "../../constants";
import {
  uploadObjectToS3,
  getSignedUploadUrl,
} from "../../services/storageService";
import { randomUUID } from "node:crypto";
import { createRateLimitMiddleware } from "../rateLimitMiddleware";
import { notifyContactFeedbackFromWeb } from "../../services/contactFeedbackNotificationService";

const submitRateLimited = createRateLimitMiddleware(
  CONTACT_FEEDBACK_RATE_LIMIT_WINDOW_MS,
  CONTACT_FEEDBACK_RATE_LIMIT_MAX,
);

const uploadUrlRateLimited = createRateLimitMiddleware(
  CONTACT_FEEDBACK_RATE_LIMIT_WINDOW_MS,
  CONTACT_FEEDBACK_UPLOAD_URL_RATE_LIMIT_MAX,
);

const submitInput = z.object({
  message: z.string().min(1).max(CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH),
  contactEmail: z.string().email().max(320).optional(),
  contactDiscord: z.string().max(100).optional(),
  recaptchaToken: z.string().optional(),
  // Legacy base64 image upload (kept for Discord command compatibility)
  images: z
    .array(
      z.object({
        data: z.string(),
        contentType: z.enum(
          CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES as [string, ...string[]],
        ),
        fileName: z.string().max(255),
      }),
    )
    .max(CONTACT_FEEDBACK_MAX_IMAGES)
    .optional(),
  // Presigned URL flow: S3 keys from getUploadUrl
  imageS3Keys: z
    .array(z.string().max(512))
    .max(CONTACT_FEEDBACK_MAX_IMAGES)
    .optional(),
  honeypot: z.string().optional(),
});

const getUploadUrl = publicProcedure
  .use(uploadUrlRateLimited)
  .input(
    z.object({
      fileName: z.string().max(255),
      contentType: z.enum(
        CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES as [string, ...string[]],
      ),
    }),
  )
  .mutation(async ({ input }) => {
    const extension = input.contentType.split("/")[1] ?? "bin";
    const key = `${CONTACT_FEEDBACK_S3_PREFIX}${randomUUID()}.${extension}`;
    const url = await getSignedUploadUrl(
      key,
      input.contentType,
      CONTACT_FEEDBACK_UPLOAD_URL_EXPIRY_SECONDS,
    );
    if (!url) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to generate upload URL",
      });
    }
    return { url, key };
  });

const submit = publicProcedure
  .use(submitRateLimited)
  .input(submitInput)
  .mutation(async ({ ctx, input }) => {
    // Honeypot check: if filled, silently succeed but don't persist
    if (input.honeypot) {
      return { ok: true };
    }

    // Validate images before uploading to avoid orphaned S3 objects
    const imagesToUpload: {
      buffer: Buffer;
      contentType: string;
      fileName: string;
    }[] = [];
    if (input.images && input.images.length > 0) {
      for (const image of input.images) {
        const buffer = Buffer.from(image.data, "base64");
        if (buffer.byteLength > CONTACT_FEEDBACK_MAX_IMAGE_BYTES) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Image "${image.fileName}" exceeds the ${CONTACT_FEEDBACK_MAX_IMAGE_BYTES / (1024 * 1024)}MB size limit`,
          });
        }
        imagesToUpload.push({
          buffer,
          contentType: image.contentType,
          fileName: image.fileName,
        });
      }
    }

    // Upload validated base64 images to S3
    const allImageS3Keys: string[] = [];
    for (const image of imagesToUpload) {
      const extension = image.contentType.split("/")[1] ?? "bin";
      const key = `${CONTACT_FEEDBACK_S3_PREFIX}${randomUUID()}.${extension}`;
      const uploaded = await uploadObjectToS3(
        key,
        image.buffer,
        image.contentType,
      );
      if (uploaded) {
        allImageS3Keys.push(uploaded);
      }
    }

    // Merge presigned-upload keys (validated by prefix, capped at max total)
    if (input.imageS3Keys) {
      for (const key of input.imageS3Keys) {
        if (allImageS3Keys.length >= CONTACT_FEEDBACK_MAX_IMAGES) break;
        if (key.startsWith(CONTACT_FEEDBACK_S3_PREFIX)) {
          allImageS3Keys.push(key);
        }
      }
    }

    const record = await submitContactFeedback({
      source: "web",
      message: input.message,
      contactEmail: input.contactEmail,
      contactDiscord: input.contactDiscord,
      recaptchaToken: input.recaptchaToken,
      userId: ctx.user?.id,
      userTag: ctx.user?.username,
      displayName: ctx.user?.username,
      imageS3Keys: allImageS3Keys,
    });

    // Fire-and-forget Discord notification for web submissions
    notifyContactFeedbackFromWeb(record).catch((err: unknown) => {
      console.error("Failed to notify contact feedback from web", err);
    });

    return { ok: true };
  });

const list = superAdminProcedure
  .input(
    z.object({
      limit: z.number().min(1).max(100).optional(),
      startAt: z.string().optional(),
      endAt: z.string().optional(),
    }),
  )
  .query(async ({ input }) => {
    const entries = await listContactFeedbackEntries({
      limit: input.limit,
      startAt: input.startAt,
      endAt: input.endAt,
    });
    return { entries };
  });

export const contactFeedbackRouter = router({ submit, list, getUploadUrl });
