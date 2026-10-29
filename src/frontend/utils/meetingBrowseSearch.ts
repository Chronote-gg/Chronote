import { z } from "zod";
import type { MeetingBrowseScope } from "../../types/meetingBrowse";

const optionalString = z.preprocess(
  (value) => (value == null ? undefined : String(value)),
  z.string().optional(),
);
const optionalBoolean = z.preprocess((value) => {
  if (value === true || value === false) return value;
  if (value == null) return undefined;
  return new Map([
    ["true", true],
    ["1", true],
    ["false", false],
    ["0", false],
  ]).get(String(value).toLowerCase());
}, z.boolean().optional());

export const meetingBrowseSearchSchema = z
  .object({
    scope: z.enum(["all", "personal", "guild"]).catch("all"),
    serverId: optionalString,
    attended: optionalBoolean.transform((value) => value ?? false),
    range: z.preprocess(
      (value) => (typeof value === "number" ? String(value) : value),
      z.enum(["all", "today", "7", "30", "custom"]).catch("all"),
    ),
    startDate: optionalString,
    endDate: optionalString,
    archive: z.enum(["active", "archived", "all"]).catch("active"),
    tags: optionalString,
    channelId: optionalString,
    q: optionalString,
    meetingServerId: optionalString,
    meetingId: optionalString,
    eventId: optionalString,
    fullScreen: optionalBoolean,
  })
  .superRefine((search, ctx) => {
    if (search.scope === "guild" && !search.serverId)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["serverId"],
        message: "A server source requires serverId",
      });
  })
  .transform((search) => {
    if (search.scope !== "guild") delete search.serverId;
    if (!search.meetingId || !search.meetingServerId) {
      delete search.meetingId;
      delete search.meetingServerId;
      delete search.eventId;
      delete search.fullScreen;
    }
    return search;
  });
export type MeetingBrowseSearch = z.infer<typeof meetingBrowseSearchSchema>;

export function selectMeetingSource(
  search: MeetingBrowseSearch,
  scope: MeetingBrowseScope,
): MeetingBrowseSearch {
  return meetingBrowseSearchSchema.parse({
    scope: scope.kind,
    serverId: scope.kind === "guild" ? scope.serverId : undefined,
    range: search.range,
    startDate: search.startDate,
    endDate: search.endDate,
    archive: search.archive,
  });
}

export function legacyLibrarySearch(
  serverId: string,
  search: unknown,
): MeetingBrowseSearch {
  const previous = z
    .object({
      meetingId: optionalString,
      eventId: optionalString,
      fullScreen: optionalBoolean,
    })
    .parse(search);
  return meetingBrowseSearchSchema.parse({
    ...previous,
    scope: "guild",
    serverId,
    meetingServerId: previous.meetingId ? serverId : undefined,
  });
}
