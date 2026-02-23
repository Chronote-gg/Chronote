import { randomUUID } from "node:crypto";
import { getContactFeedbackRepository } from "../repositories/contactFeedbackRepository";
import type { ContactFeedbackRecord, ContactFeedbackSource } from "../types/db";
import {
  CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH,
  CONTACT_FEEDBACK_RECAPTCHA_THRESHOLD,
} from "../constants";
import { config } from "./configService";

export interface ContactFeedbackInput {
  source: ContactFeedbackSource;
  message: string;
  contactEmail?: string;
  contactDiscord?: string;
  userId?: string;
  userTag?: string;
  displayName?: string;
  guildId?: string;
  imageS3Keys?: string[];
  recaptchaToken?: string;
}

export async function verifyRecaptcha(token: string): Promise<number> {
  const secretKey = config.contactFeedback.recaptchaSecretKey;
  if (!secretKey) return 1;

  try {
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      },
    );

    const data = (await response.json()) as {
      success: boolean;
      score?: number;
    };
    if (!data.success) return 0;
    return data.score ?? 0;
  } catch (error) {
    console.error("reCAPTCHA verification failed:", error);
    return 0;
  }
}

export async function submitContactFeedback(
  input: ContactFeedbackInput,
): Promise<ContactFeedbackRecord> {
  if (!input.message.trim()) {
    throw new Error("Feedback message is required");
  }
  if (input.message.length > CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message exceeds maximum length of ${CONTACT_FEEDBACK_MAX_MESSAGE_LENGTH} characters`,
    );
  }

  let recaptchaScore: number | undefined;
  if (input.recaptchaToken) {
    recaptchaScore = await verifyRecaptcha(input.recaptchaToken);
    if (recaptchaScore < CONTACT_FEEDBACK_RECAPTCHA_THRESHOLD) {
      throw new Error("reCAPTCHA verification failed");
    }
  }

  const record: ContactFeedbackRecord = {
    feedbackId: randomUUID(),
    type: "contact_feedback",
    source: input.source,
    message: input.message.trim(),
    contactEmail: input.contactEmail?.trim() || undefined,
    contactDiscord: input.contactDiscord?.trim() || undefined,
    userId: input.userId,
    userTag: input.userTag,
    displayName: input.displayName,
    guildId: input.guildId,
    imageS3Keys:
      input.imageS3Keys && input.imageS3Keys.length > 0
        ? input.imageS3Keys
        : undefined,
    recaptchaScore,
    createdAt: new Date().toISOString(),
  };

  const repo = getContactFeedbackRepository();
  await repo.write(record);
  return record;
}

export async function listContactFeedbackEntries(params: {
  limit?: number;
  startAt?: string;
  endAt?: string;
}): Promise<ContactFeedbackRecord[]> {
  const repo = getContactFeedbackRepository();
  return repo.list(params);
}
