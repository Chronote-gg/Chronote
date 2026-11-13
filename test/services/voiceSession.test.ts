/** @jest-environment node */
import { getVoiceConnection, VoiceConnectionStatus } from "@discordjs/voice";
import {
  dropVoiceLocally,
  joinVoice,
  leaveVoice,
} from "../../src/services/voiceSession";
import { fakeVoiceGuild as fakeGuild } from "./voiceSession.fixture";

const VOICE_CHANNEL_ID = "100000000000000001";
const stillOwned = () => true;

async function joinedConnection(owned: () => boolean = stillOwned) {
  const { guild, sent } = fakeGuild();
  const abort = new AbortController();
  const joining = joinVoice({
    voiceChannel: { id: VOICE_CHANNEL_ID },
    guild,
    captureAudio: true,
    signal: abort.signal,
    stillOwned: owned,
  });
  const connection = getVoiceConnection(guild.id);
  abort.abort();
  await expect(joining).rejects.toThrow();
  return { connection, sent, guild };
}

test("join times out through the signal", async () => {
  const { guild, sent } = fakeGuild();
  const joining = joinVoice({
    voiceChannel: { id: VOICE_CHANNEL_ID },
    guild,
    captureAudio: false,
    signal: AbortSignal.timeout(10),
    stillOwned,
  });

  await expect(joining).rejects.toThrow();

  expect(sent[0].d).toMatchObject({
    channel_id: VOICE_CHANNEL_ID,
    self_deaf: true,
    self_mute: false,
  });
  expect(getVoiceConnection(guild.id)).toBeUndefined();
});

test("a failed join by a worker that still owns the server sends a leave", async () => {
  const { connection, sent } = await joinedConnection();

  expect(connection?.state.status).toBe(VoiceConnectionStatus.Destroyed);
  expect(sent[0].d).toMatchObject({ self_deaf: false });
  // The join, then the leave that tells Discord the bot is gone.
  expect(sent.map((payload) => payload.d.channel_id)).toEqual([
    VOICE_CHANNEL_ID,
    null,
  ]);
});

test("a failed join by a worker that no longer owns the server is dropped locally", async () => {
  const { connection, sent } = await joinedConnection(() => false);

  expect(connection?.state.status).toBe(VoiceConnectionStatus.Destroyed);
  // A leave would disconnect whichever worker now holds the server's voice state.
  expect(sent.map((payload) => payload.d.channel_id)).toEqual([
    VOICE_CHANNEL_ID,
  ]);
});

function pendingConnection() {
  const { guild, sent } = fakeGuild();
  void joinVoice({
    voiceChannel: { id: VOICE_CHANNEL_ID },
    guild,
    captureAudio: true,
    signal: new AbortController().signal,
    stillOwned,
  }).catch(() => undefined);
  const connection = getVoiceConnection(guild.id);
  if (!connection) throw new Error("join did not create a connection");
  return { connection, sent };
}

test("leave sends a voice state update", () => {
  const { connection, sent } = pendingConnection();

  leaveVoice(connection);
  leaveVoice(connection);

  expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
  expect(sent.map((payload) => payload.d.channel_id)).toEqual([
    VOICE_CHANNEL_ID,
    null,
  ]);
});

test("local drop sends no voice state", () => {
  const { connection, sent } = pendingConnection();

  dropVoiceLocally(connection);
  dropVoiceLocally(connection);
  leaveVoice(connection);

  expect(connection.state.status).toBe(VoiceConnectionStatus.Destroyed);
  expect(sent.map((payload) => payload.d.channel_id)).toEqual([
    VOICE_CHANNEL_ID,
  ]);
});
