import type { Client, VoiceState, Guild, Message } from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";
import type { SessionReservation } from "../types/deploymentControl";
import {
  armFixtureObservation,
  failFixture,
  fixtureInputSnapshot,
  observeFixtureMember,
  observeFixtureMessage,
} from "./fixtureInputService";
export function observeFixtureChannel(input: {
  reservation: SessionReservation;
  client: Client;
  guild: Guild;
  channelId: string;
  memberIds: () => string[];
  signal: AbortSignal;
}): () => void {
  const fixture = fixtureInputSnapshot(input);
  if (!fixture) return () => {};
  const botId = input.client.user!.id;
  const voice = (before: VoiceState, after: VoiceState) => {
    if (
      after.guild.id !== input.guild.id ||
      before.channelId === after.channelId
    )
      return;
    if (before.channelId === input.channelId)
      observeFixtureMember(input, before.id, false, botId);
    if (after.channelId === input.channelId)
      observeFixtureMember(input, after.id, true, botId);
  };
  const message = (value: Message) => {
    if (
      value.guildId !== input.guild.id ||
      value.channelId !== input.channelId ||
      value.author.id === botId
    )
      return;
    observeFixtureMessage(input, value.attachments.size);
  };
  const shardGap = (id: number) => {
    if (id === input.guild.shardId) failFixture(input, "observer_gap");
  };
  const shardDisconnect = (_event: unknown, id: number) => shardGap(id);
  const unavailable = (guild: Guild) => {
    if (guild.id === input.guild.id) failFixture(input, "observer_gap");
  };
  const abort = () => failFixture(input, "ownership_lost");
  input.client.on("voiceStateUpdate", voice);
  input.client.on("messageCreate", message);
  input.client.on("shardDisconnect", shardDisconnect);
  input.client.on("shardError", shardDisconnect);
  input.client.on("shardReconnecting", shardGap);
  input.client.on("guildUnavailable", unavailable);
  input.signal.addEventListener("abort", abort, { once: true });
  const detach = () => {
    input.client.off("voiceStateUpdate", voice);
    input.client.off("messageCreate", message);
    input.client.off("shardDisconnect", shardDisconnect);
    input.client.off("shardError", shardDisconnect);
    input.client.off("shardReconnecting", shardGap);
    input.client.off("guildUnavailable", unavailable);
    input.signal.removeEventListener("abort", abort);
  };
  armFixtureObservation(input, detach);
  if (input.signal.aborted) failFixture(input, "ownership_lost");
  if (input.guild.available === false) failFixture(input, "observer_gap");
  const members = input.memberIds();
  for (const id of members) observeFixtureMember(input, id, true, botId);
  if (!members.includes(fixture.actorUserId)) {
    failFixture(input, "actor_absent");
    detach();
    throw new Error("Fixture actor must be present before capture");
  }
  return () => {
    if (!fixtureInputSnapshot(input)?.observationEndedAt)
      failFixture(input, "observer_gap");
    detach();
  };
}
export function observeFixtureConnection(
  meeting: { reservation?: SessionReservation },
  connection: VoiceConnection,
) {
  if (!fixtureInputSnapshot(meeting)) return;
  connection.on("stateChange", (before, after) => {
    if (
      before.status === "ready" &&
      after.status !== "ready" &&
      !fixtureInputSnapshot(meeting)?.observationEndedAt
    )
      failFixture(meeting, "observer_gap");
  });
  connection.on("error", () => {
    if (!fixtureInputSnapshot(meeting)?.observationEndedAt)
      failFixture(meeting, "observer_gap");
  });
}
