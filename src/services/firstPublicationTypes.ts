import { z } from "zod";
import { createHash } from "node:crypto";
import { stableJson } from "../utils/stableJson";
import type { MeetingHistory } from "../types/db";
import type { DiscordEditorMessage } from "./discordMessageEditor";
export const publicationKeySchema = z
  .object({
    guildId: z.string().regex(/^\d+$/),
    channelId_timestamp: z.string().min(1).max(512),
  })
  .strict();
export type PublicationKey = z.infer<typeof publicationKeySchema>;
export type PublicationSelection = PublicationKey[];
export const publicationProfileSchema = z
  .object({
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().min(1),
    historyTable: z.string().min(1),
    activeTable: z.string().min(1),
    controlTable: z.string().min(1),
    bucket: z.string().min(1),
    archiveWriters: z
      .array(
        z
          .object({ cluster: z.string().min(1), service: z.string().min(1) })
          .strict(),
      )
      .min(1),
    tokenSecretId: z.string().optional(),
  })
  .strict();
export type PublicationProfile = z.infer<typeof publicationProfileSchema>;
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const digest = (v: unknown) => hash(stableJson(v));
export const keyId = (key: PublicationKey) =>
  key.guildId + "/" + key.channelId_timestamp;
export type BoundRecovery = {
  key: PublicationKey;
  row: MeetingHistory;
  recoveryId: string;
  authority: string;
  notesSha256: string;
  sourceDigest: string;
  manifestDigest: string;
};
export const payloadSchema = z
  .object({
    embeds: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
    components: z.array(z.record(z.string(), z.unknown())),
    allowed_mentions: z
      .object({ parse: z.array(z.never()).length(0) })
      .strict(),
  })
  .strict();
export type PublicationPayload = z.infer<typeof payloadSchema>;
export const pageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }).strict(),
  z.object({ kind: z.literal("submitted"), at: z.string() }).strict(),
  z
    .object({ kind: z.literal("rejected"), at: z.string(), status: z.number() })
    .strict(),
  z
    .object({
      kind: z.literal("verified"),
      at: z.string(),
      messageId: z.string(),
      fingerprint: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("uncertain"),
      at: z.string(),
      messageId: z.string().optional(),
    })
    .strict(),
]);
export type PublicationPage = z.infer<typeof pageSchema>;
export const attemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    generation: z.number().int().positive(),
    authority: z.string(),
    key: publicationKeySchema,
    planDigest: z.string(),
    sourceDigest: z.string(),
    channelId: z.string(),
    botId: z.string(),
    payloads: z.array(payloadSchema).min(1),
    pages: z.array(pageSchema).min(1),
    ownerState: z.enum(["running", "settled"]),
    outcome: z.enum(["pending", "verified", "unsent"]),
    updatedAt: z.string(),
    processId: z.string().min(1),
  })
  .strict()
  .refine((a) => a.pages.length === a.payloads.length);
export type FirstPublicationReceipt = z.infer<typeof attemptSchema>;
const bindingSchema = z
  .object({
    authority: z.string(),
    recoveryId: z.string(),
    sourceDigest: z.string(),
    manifestDigest: z.string(),
    notesSha256: z.string(),
    notesVersion: z.number().int().positive(),
    channelId: z.string(),
    botId: z.string(),
    snapshot: z.record(z.string(), z.unknown()),
    payloads: z.array(payloadSchema).min(1),
  })
  .strict();
export const planMeetingSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      key: publicationKeySchema,
      outcome: z.literal("skipped_archived"),
    })
    .strict(),
  z
    .object({
      key: publicationKeySchema,
      outcome: z.literal("already_published"),
      binding: bindingSchema,
      receipt: attemptSchema,
    })
    .strict(),
  z
    .object({
      key: publicationKeySchema,
      outcome: z.literal("ready"),
      binding: bindingSchema,
    })
    .strict(),
  z
    .object({
      key: publicationKeySchema,
      outcome: z.literal("blocked"),
      reason: z.string(),
    })
    .strict(),
]);
export type PlanMeeting = z.infer<typeof planMeetingSchema>;
export const planSchema = z
  .object({
    schemaVersion: z.literal(1),
    operation: z.enum(["publish", "finalize", "release", "continue"]),
    profile: publicationProfileSchema,
    createdAt: z.string(),
    ready: z.boolean(),
    meetings: z.array(planMeetingSchema).min(1).max(25),
    resolution: z.array(
      z
        .object({
          authority: z.string(),
          receiptDigest: z.string(),
          stoppedEvidence: z.string(),
        })
        .strict(),
    ),
    digest: z.string(),
  })
  .strict();
export type FirstPublicationPlan = z.infer<typeof planSchema>;
export type PublicationResult = {
  meetings: Array<{
    key: PublicationKey;
    outcome:
      | "verified"
      | "already_published"
      | "skipped_archived"
      | "blocked"
      | "partial"
      | "uncertain"
      | "unsent";
    reason?: string;
    messageIds?: string[];
  }>;
};
export type RuntimeCompatibility =
  | { kind: "compatible"; generation: number; control: Record<string, unknown> }
  | { kind: "blocked"; reason: string };
export type FirstPublicationRepository = {
  acquireBatch(input: {
    entries: Array<{
      receipt: FirstPublicationReceipt;
      snapshot: Record<string, unknown>;
    }>;
    runtime: Extract<RuntimeCompatibility, { kind: "compatible" }>;
  }): Promise<"owned" | "stale">;
  getStrong(key: PublicationKey): Promise<MeetingHistory | undefined>;
  readAttempt(authority: string): Promise<FirstPublicationReceipt | null>;
  acquire(input: {
    receipt: FirstPublicationReceipt;
    snapshot: Record<string, unknown>;
    runtime: Extract<RuntimeCompatibility, { kind: "compatible" }>;
  }): Promise<"owned" | "stale">;
  recordPage(
    before: FirstPublicationReceipt,
    after: FirstPublicationReceipt,
  ): Promise<"applied" | "stale">;
  settleVerified(
    receipt: FirstPublicationReceipt,
    snapshot: Record<string, unknown>,
  ): Promise<"applied" | "stale">;
  settleUnsent(
    receipt: FirstPublicationReceipt,
    snapshot: Record<string, unknown>,
  ): Promise<"applied" | "stale">;
  transferStoppedRun(
    before: FirstPublicationReceipt,
    after: FirstPublicationReceipt,
    snapshot: Record<string, unknown>,
  ): Promise<"owned" | "stale">;
};
export type FirstPublicationDependencies = {
  profile: PublicationProfile;
  now(): string;
  processId: string;
  identity(): Promise<string>;
  repository: FirstPublicationRepository;
  readObject(key: string): Promise<string>;
  targetActive(key: PublicationKey, meetingId: string): Promise<boolean>;
  runtime(): Promise<RuntimeCompatibility>;
  discord: {
    getBotIdentity(): Promise<{ id: string; bot: true }>;
    inspectDestination(
      guildId: string,
      channelId: string,
    ): Promise<{ allowed: boolean; reason?: string }>;
    duplicateEvidence(
      key: PublicationKey,
      channelId: string,
    ): Promise<{ ambiguous: boolean; bounds: string }>;
    getMessage(
      channelId: string,
      messageId: string,
    ): Promise<DiscordEditorMessage | null>;
    createNotesMessage(input: {
      channelId: string;
      payload: PublicationPayload;
    }): Promise<DiscordEditorMessage>;
  };
  stopped(processId: string): Promise<string | null>;
};
