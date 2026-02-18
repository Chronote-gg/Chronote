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
} from "../../constants";
import { uploadObjectToS3 } from "../../services/storageService";
import { randomUUID } from "node:crypto";

const submitInput = z.object({
  message: z.string().min(1).max(CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH),
  contactEmail: z.string().email().max(320).optional(),
  contactDiscord: z.string().max(100).optional(),
  recaptchaToken: z.string().optional(),
  images: z
    .array(
      z.object({
        data: z.string(), // base64-encoded image data
        contentType: z.enum(
          CONTACT_FEEDBACK_ALLOWED_IMAGE_TYPES as [string, ...string[]],
        ),
        fileName: z.string().max(255),
      }),
    )
    .max(CONTACT_FEEDBACK_MAX_IMAGES)
    .optional(),
  honeypot: z.string().max(0).optional(), // Must be empty to pass
});

const submit = publicProcedure
  .input(submitInput)
  .mutation(async ({ ctx, input }) => {
    // Honeypot check: if filled, silently succeed but don't persist
    if (input.honeypot) {
      return { ok: true };
    }

    // Upload images to S3 if present
    const imageS3Keys: string[] = [];
    if (input.images && input.images.length > 0) {
      for (const image of input.images) {
        const buffer = Buffer.from(image.data, "base64");
        if (buffer.byteLength > CONTACT_FEEDBACK_MAX_IMAGE_BYTES) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Image "${image.fileName}" exceeds the ${CONTACT_FEEDBACK_MAX_IMAGE_BYTES / (1024 * 1024)}MB size limit`,
          });
        }
        const extension = image.contentType.split("/")[1] ?? "bin";
        const key = `${CONTACT_FEEDBACK_S3_PREFIX}${randomUUID()}.${extension}`;
        const uploaded = await uploadObjectToS3(key, buffer, image.contentType);
        if (uploaded) {
          imageS3Keys.push(uploaded);
        }
      }
    }

    await submitContactFeedback({
      source: "web",
      message: input.message,
      contactEmail: input.contactEmail,
      contactDiscord: input.contactDiscord,
      recaptchaToken: input.recaptchaToken,
      userId: ctx.user?.id,
      userTag: ctx.user?.username,
      displayName: ctx.user?.username,
      imageS3Keys,
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

export const contactFeedbackRouter = router({ submit, list });
