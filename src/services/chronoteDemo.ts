import { z } from "zod";
import { CONFIG_KEYS } from "../config/keys";
import { getGlobalConfigValues } from "./appConfigService";

const discordId = z.string().regex(/^\d{17,20}$/);
const demoChannels = z
  .object({
    guildId: discordId,
    voiceChannelId: discordId,
    outputChannelId: discordId,
    aboutChannelId: discordId.optional(),
    supportChannelId: discordId.optional(),
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
