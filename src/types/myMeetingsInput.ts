import { z } from "zod";

export const myMeetingsInputFields = {
  mode: z.enum(["attended", "accessible"]).optional(),
  range: z.enum(["all", "today", "past_7_days", "custom"]).optional(),
  cursor: z.string().min(1).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  timeZoneOffsetMinutes: z
    .number()
    .int()
    .min(-14 * 60)
    .max(14 * 60)
    .optional(),
  serverIds: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  archivedOnly: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
};
