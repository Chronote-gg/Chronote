import { createHash, createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./configService";
import {
  getMeetingBrowseCursorState,
  putMeetingBrowseCursorState,
} from "../db";
import { readConsentToken, signConsentToken } from "../utils/consentToken";
import type { MeetingBrowseFilters } from "../types/meetingBrowse";

export const meetingBrowseFiltersSchema = z.object({
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }),
    z.object({ kind: z.literal("personal") }),
    z.object({ kind: z.literal("guild"), serverId: z.string().min(1) }),
  ]),
  attendedOnly: z.boolean(),
  channelId: z.string().min(1).optional(),
});
// These two indexes use string key attributes only. Retain the complete key map.
const checkpointSchema = z.record(z.string(), z.object({ S: z.string() }));
export const meetingBrowseSourceSchema = z.object({
  kind: z.enum(["guild", "user", "guild_share"]),
  id: z.string().min(1),
  checkpoint: checkpointSchema.optional(),
  exhausted: z.boolean(),
});
const lookupSchema = z.object({
  guildId: z.string().min(1),
  channelId_timestamp: z.string().min(1),
  timestamp: z.string().datetime(),
});
const payloadSchema = z.object({
  version: z.literal(2),
  actorId: z.string().min(1),
  filterFingerprint: z.string(),
  requestFingerprint: z.string(),
  startTimestamp: z.string().datetime(),
  endTimestamp: z.string().datetime(),
  expiresAt: z.number().int(),
  sources: z.array(meetingBrowseSourceSchema),
  legacy: z
    .object({
      mode: z.enum(["attended", "accessible"]),
      range: z.enum(["all", "today", "past_7_days", "custom"]),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      timeZoneOffsetMinutes: z.number().optional(),
      serverIds: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      archivedOnly: z.boolean().optional(),
      includeArchived: z.boolean().optional(),
    })
    .optional(),
  watermark: z
    .object({ timestamp: z.string().datetime(), identity: z.string() })
    .optional(),
  pending: z.array(lookupSchema).max(101),
  tie: z
    .object({
      timestamp: z.string().datetime(),
      starts: z.array(meetingBrowseSourceSchema),
      overflow: z.boolean(),
    })
    .optional(),
});
export type MeetingBrowseCursorPayload = z.infer<typeof payloadSchema>;
export type MeetingBrowseSource = z.infer<typeof meetingBrowseSourceSchema>;
export type MeetingBrowseLookup = z.infer<typeof lookupSchema>;
export const meetingBrowseFingerprint = (filters: MeetingBrowseFilters) =>
  createHash("sha256")
    .update(JSON.stringify(meetingBrowseFiltersSchema.parse(filters)))
    .digest("hex");
const referenceSchema = z
  .object({
    version: z.literal(2),
    purpose: z.literal("meeting-browse"),
    id: z.string().uuid(),
    actorId: z.string(),
    filterFingerprint: z.string(),
    expiresAt: z.number().int(),
  })
  .strict();
type Reference = z.infer<typeof referenceSchema>;
const signingKey = () =>
  createHmac("sha256", config.server.sessionSecret)
    .update("chronote:meeting-browse:v2")
    .digest("hex");
export class InvalidMeetingBrowseCursorError extends Error {
  constructor() {
    super("Invalid or expired Meetings cursor. Refresh the meeting list.");
  }
}
export async function encodeMeetingBrowseCursor(
  payload: MeetingBrowseCursorPayload,
): Promise<string> {
  const state = payloadSchema.parse(payload);
  const id = randomUUID();
  await putMeetingBrowseCursorState(id, state, state.expiresAt);
  return signConsentToken(
    {
      version: 2,
      purpose: "meeting-browse",
      id,
      actorId: state.actorId,
      filterFingerprint: state.filterFingerprint,
      expiresAt: state.expiresAt,
    },
    signingKey(),
  );
}
export async function decodeMeetingBrowseCursor(
  token: string,
  actorId: string,
  filters: MeetingBrowseFilters,
  now = Date.now(),
): Promise<MeetingBrowseCursorPayload> {
  if (token.split(".").length !== 2)
    throw new InvalidMeetingBrowseCursorError();
  const reference = readConsentToken(
    token,
    signingKey(),
    (value): value is Reference => referenceSchema.safeParse(value).success,
    now,
  );
  const fingerprint = meetingBrowseFingerprint(filters);
  if (
    !reference ||
    reference.actorId !== actorId ||
    reference.filterFingerprint !== fingerprint
  )
    throw new InvalidMeetingBrowseCursorError();
  const parsed = payloadSchema.safeParse(
    await getMeetingBrowseCursorState(reference.id, now),
  );
  if (
    !parsed.success ||
    parsed.data.actorId !== actorId ||
    parsed.data.filterFingerprint !== fingerprint ||
    parsed.data.expiresAt !== reference.expiresAt ||
    parsed.data.expiresAt <= now
  )
    throw new InvalidMeetingBrowseCursorError();
  return parsed.data;
}
