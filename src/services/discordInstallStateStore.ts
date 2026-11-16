import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { InstallAttribution } from "../types/db";
import {
  readInstallAttributionFromRequest,
  setInstallAttributionOnRequest,
} from "./installAttributionService";
import { DiscordStateStore, discordStateClient } from "./discordStateStore";
export {
  DISCORD_INSTALL_SESSION_KEY,
  INSTALL_FLOW_TTL_MS,
  MAX_PENDING_INSTALL_FLOWS,
  isDiscordInstallState,
  readDiscordInstallBinding,
  restoreDiscordInstallBinding,
} from "./discordStateStore";
export class DiscordInstallStateStore extends DiscordStateStore<
  InstallAttribution | undefined
> {
  constructor(client?: DynamoDBClient) {
    super(
      "install",
      readInstallAttributionFromRequest,
      setInstallAttributionOnRequest,
      client,
    );
  }
}
export const discordInstallStateStore = new DiscordInstallStateStore(
  discordStateClient,
);
