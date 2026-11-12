/** @jest-environment node */
import {
  getVoiceConnection,
  VoiceConnectionStatus,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import {
  dropVoiceLocally,
  joinVoice,
  leaveVoice,
} from "../../src/services/voiceSession";

const VOICE_CHANNEL_ID = "100000000000000001";
let nextGuildId = 200000000000000001n;

type SentPayload = { op: number; d: { channel_id: string | null } };

/** The real library over a fake gateway adapter, so payloads can be observed. */
function fakeGuild() {
  const sent: SentPayload[] = [];
  const voiceAdapterCreator: DiscordGatewayAdapterCreator = () => ({
    sendPayload(payload) {
      sent.push(payload);
      return true;
    },
    destroy() {},
  });
  const id = String(nextGuildId++);
  return { guild: { id, voiceAdapterCreator }, sent };
}

async function joinedConnection() {
  const { guild, sent } = fakeGuild();
  const abort = new AbortController();
  const joining = joinVoice({
    voiceChannel: { id: VOICE_CHANNEL_ID },
    guild,
    captureAudio: true,
    signal: abort.signal,
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
  });

  await expect(joining).rejects.toThrow();

  expect(sent[0].d).toMatchObject({
    channel_id: VOICE_CHANNEL_ID,
    self_deaf: true,
    self_mute: false,
  });
  expect(getVoiceConnection(guild.id)).toBeUndefined();
});

test("a failed join destroys the connection", async () => {
  const { connection, sent } = await joinedConnection();

  expect(connection?.state.status).toBe(VoiceConnectionStatus.Destroyed);
  expect(sent[0].d).toMatchObject({ self_deaf: false });
  // The join, then the leave that tells Discord the bot is gone.
  expect(sent.map((payload) => payload.d.channel_id)).toEqual([
    VOICE_CHANNEL_ID,
    null,
  ]);
});

function pendingConnection() {
  const { guild, sent } = fakeGuild();
  void joinVoice({
    voiceChannel: { id: VOICE_CHANNEL_ID },
    guild,
    captureAudio: true,
    signal: new AbortController().signal,
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
