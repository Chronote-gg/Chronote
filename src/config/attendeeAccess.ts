import type { ConfigEntry } from "./types";
import { CONFIG_KEYS } from "./keys";
import { scope } from "./configEntryBuilders";

export const attendeeAccessConfigEntry: ConfigEntry = {
  key: CONFIG_KEYS.meetings.attendeeAccessEnabled,
  label: "Attendee access",
  description:
    "Allow meeting participants to access a meeting in the portal even if they later lose channel permissions.",
  category: "Library",
  group: "Standard",
  valueType: "boolean",
  defaultValue: true,
  scopes: {
    server: scope(true, true, "admin", "toggle"),
  },
  ui: { type: "toggle" },
};
