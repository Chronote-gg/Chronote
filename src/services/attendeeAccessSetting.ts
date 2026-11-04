import { CONFIG_KEYS } from "../config/keys";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";

/** The caller decides whether an unreadable setting grants or denies attendee access. */
export async function readAttendeeAccessSetting(
  guildId: string,
  whenUnreadable: boolean,
): Promise<boolean> {
  try {
    const snapshot = await resolveConfigSnapshot({ guildId });
    return getSnapshotBoolean(
      snapshot,
      CONFIG_KEYS.meetings.attendeeAccessEnabled,
    );
  } catch (error) {
    console.warn("Failed to resolve attendee access setting", {
      guildId,
      error,
    });
    return whenUnreadable;
  }
}

/** Meeting access checks fail open, so a config read error does not lock attendees out. */
export const resolveAttendeeAccessEnabled = (guildId: string) =>
  readAttendeeAccessSetting(guildId, true);
