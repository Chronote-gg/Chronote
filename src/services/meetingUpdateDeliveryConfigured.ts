import { getMeetingUpdateDeliveryRepository } from "../db";
import { config } from "./configService";
import { createDiscordMeetingUpdateTransport } from "./discordMeetingUpdateTransport";
import { createMeetingUpdateDeliveryService } from "./meetingUpdateDeliveryService";

export const configuredMeetingUpdateDelivery =
  createMeetingUpdateDeliveryService({
    repository: getMeetingUpdateDeliveryRepository(),
    discord: createDiscordMeetingUpdateTransport({
      token: config.discord.botToken,
    }),
  });
