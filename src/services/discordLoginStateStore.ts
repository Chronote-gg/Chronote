import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { Request } from "express";
import { DiscordStateStore, discordStateClient } from "./discordStateStore";
export type DiscordLoginIntent = {
  returnTo: string;
  prompt: "none" | "consent";
  recoveryId: string | null;
};
const intents = new WeakMap<Request, DiscordLoginIntent>();
export function setDiscordLoginIntent(
  req: Request,
  intent: DiscordLoginIntent | undefined,
) {
  if (intent) intents.set(req, intent);
  else intents.delete(req);
}
export const readDiscordLoginIntent = (req: Request) => intents.get(req);
export class DiscordLoginStateStore extends DiscordStateStore<DiscordLoginIntent> {
  constructor(client?: DynamoDBClient) {
    super(
      "login",
      (req) => {
        const intent = readDiscordLoginIntent(req);
        if (!intent)
          throw new Error("Discord login requires a validated intent");
        return intent;
      },
      setDiscordLoginIntent,
      client,
    );
  }
}
export const discordLoginStateStore = new DiscordLoginStateStore(
  discordStateClient,
);
