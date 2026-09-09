import { setTimeout as delay } from "node:timers/promises";
import { fetchGuildInstallerForMembership } from "./guildInstallerService";

// Discord can announce the guild before the browser finishes its OAuth callback.
// Direct installs have no callback, so retain the owner fallback after a bound.
const CALLBACK_WAIT_ATTEMPTS = 10;
const CALLBACK_POLL_MS = 1000;

export async function waitForGuildInstaller(
  guildId: string,
  joinedTimestamp: number,
) {
  for (let attempt = 0; attempt < CALLBACK_WAIT_ATTEMPTS; attempt++) {
    const installer = await fetchGuildInstallerForMembership(
      guildId,
      joinedTimestamp,
    );
    if (installer) return installer;
    if (attempt + 1 < CALLBACK_WAIT_ATTEMPTS) await delay(CALLBACK_POLL_MS);
  }
  return undefined;
}
