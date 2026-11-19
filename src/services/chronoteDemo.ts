import { z } from "zod";
import { CONFIG_KEYS } from "../config/keys";
import { getGlobalConfigValues } from "./appConfigService";

export const GUIDED_DEMO_CONTEXT =
  "This is a guided demo of Chronote, showing how it turns a voice conversation into meeting notes. Capture the actual topic, examples and next steps discussed. Identify practice scenarios as examples and avoid adding capabilities or commitments that did not come up.";

export function guidedDemoContext(enabled?: boolean): string | undefined {
  return enabled ? GUIDED_DEMO_CONTEXT : undefined;
}

const discordId = z.string().regex(/^\d{17,20}$/);
const demoChannels = z
  .object({
    guildId: discordId,
    voiceChannelId: discordId,
    outputChannelId: discordId,
    aboutChannelId: discordId.optional(),
    supportChannelId: discordId.optional(),
    stats: z
      .object({
        completedMeetings: z.number().int().nonnegative(),
        recordedHours: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function getChronoteDemo() {
  const values = await getGlobalConfigValues();
  const raw = values[CONFIG_KEYS.demo.channels];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    return demoChannels.parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
