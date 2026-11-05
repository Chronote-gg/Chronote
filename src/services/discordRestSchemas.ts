import { z } from "zod";

/** A Discord REST channel's permission_overwrites array, as the API returns it. */
export const permissionOverwritesSchema = z.array(
  z.object({
    id: z.string(),
    type: z.number(),
    allow: z.string(),
    deny: z.string(),
  }),
);
