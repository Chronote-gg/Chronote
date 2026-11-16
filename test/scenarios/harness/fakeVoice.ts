import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import type * as DiscordVoice from "@discordjs/voice";
import type * as PrismMedia from "prism-media";
import type { WorkerGate } from "./world";

/** Discord delivers voice as 20 ms Opus frames; decoded, each is 48 kHz stereo 16 bit PCM. */
export const FRAME_MS = 20;
export const FRAME_BYTES = 3_840;
/**
 * One frame of every turn arrives together with the previous one, then the
 * stream pauses for two frames, as network jitter delivers real audio. The
 * early frame lands before the previous frame's sample end, so the piece
 * carries a positive cursor adjustment, as production pieces do.
 */
const BURST_FRAME = 2;
const BURST_GAP_MS = 2 * FRAME_MS;

export type VoiceDeparture = {
  guildId: string;
  kind: "leave" | "local_drop";
};

class FakeSpeakingMap extends EventEmitter {
  readonly users = new Map<string, number>();
}

class FakeReceiver {
  readonly speaking = new FakeSpeakingMap();
  readonly subscriptions = new Map<string, PassThrough>();
  readonly packetDiagnostics = new WeakMap<Buffer, never>();

  subscribe(userId: string): PassThrough {
    const existing = this.subscriptions.get(userId);
    if (existing) return existing;
    const stream = new PassThrough();
    stream.once("close", () => {
      if (this.subscriptions.get(userId) === stream)
        this.subscriptions.delete(userId);
    });
    this.subscriptions.set(userId, stream);
    return stream;
  }
}

class FakeVoiceConnection extends EventEmitter {
  readonly receiver = new FakeReceiver();
  state: { status: DiscordVoice.VoiceConnectionStatus };

  constructor(
    readonly joinConfig: { guildId: string; channelId: string | null },
    private readonly voice: typeof DiscordVoice,
    private readonly onDestroy: (
      adapterAvailable: boolean,
      honoured: boolean,
    ) => void,
    stalled: boolean,
    private readonly alive: () => boolean,
  ) {
    super();
    this.state = {
      status: stalled
        ? voice.VoiceConnectionStatus.Signalling
        : voice.VoiceConnectionStatus.Ready,
    };
  }

  subscribe() {
    return { unsubscribe() {} };
  }

  /** `adapterAvailable: false` is how a local drop (no gateway leave) is told apart from a leave. */
  destroy(adapterAvailable = true): void {
    // A dead process sends no leave and drops nothing anyone can observe; the attempt is still recorded.
    if (!this.alive()) {
      this.onDestroy(adapterAvailable, false);
      return;
    }
    const oldState = this.state;
    this.state = { status: this.voice.VoiceConnectionStatus.Destroyed };
    for (const stream of this.receiver.subscriptions.values()) stream.destroy();
    this.onDestroy(adapterAvailable, true);
    this.emit("stateChange", oldState, this.state);
  }
}

/** One worker's voice connections: the test pushes audio, the worker's receiver hears it. */
export class FakeVoice {
  readonly connections = new Map<string, FakeVoiceConnection>();
  readonly departures: VoiceDeparture[] = [];
  /** Destroys asked for after the worker died; they reach nobody. */
  readonly departuresAfterDeath: VoiceDeparture[] = [];
  /** While true, a join never reaches Ready, as when Discord's voice server never answers. */
  stallJoins = false;

  constructor(private readonly gate: WorkerGate) {}

  createModule(actual: typeof DiscordVoice) {
    return {
      ...actual,
      joinVoiceChannel: (options: { guildId: string; channelId: string }) => {
        this.gate.assertAlive();
        const connection: FakeVoiceConnection = new FakeVoiceConnection(
          options,
          actual,
          (adapterAvailable, honoured) => {
            const departure: VoiceDeparture = {
              guildId: options.guildId,
              kind: adapterAvailable ? "leave" : "local_drop",
            };
            if (!honoured) {
              this.departuresAfterDeath.push(departure);
              return;
            }
            if (this.connections.get(options.guildId) === connection)
              this.connections.delete(options.guildId);
            this.departures.push(departure);
          },
          this.stallJoins,
          () => this.gate.alive,
        );
        this.connections.set(options.guildId, connection);
        return connection;
      },
      getVoiceConnection: (guildId: string) => this.connections.get(guildId),
    };
  }

  /**
   * One speaking turn on the real clock: start, the PCM to the user's
   * subscription as 20 ms frames with one burst, end. Resolves with the time
   * the last frame was delivered.
   */
  async speak(guildId: string, userId: string, pcm: Buffer): Promise<number> {
    this.gate.assertAlive();
    const connection = this.connections.get(guildId);
    if (!connection)
      throw new Error(`No scenario voice connection in ${guildId}`);
    const { speaking, subscriptions } = connection.receiver;
    speaking.users.set(userId, Date.now());
    speaking.emit("start", userId);
    let lastFrameAt = Date.now();
    for (let frame = 0; frame * FRAME_BYTES < pcm.length; frame += 1) {
      this.gate.assertAlive();
      subscriptions
        .get(userId)
        ?.write(pcm.subarray(frame * FRAME_BYTES, (frame + 1) * FRAME_BYTES));
      lastFrameAt = Date.now();
      if (frame + 1 !== BURST_FRAME)
        await pause(frame === BURST_FRAME ? BURST_GAP_MS : FRAME_MS);
    }
    speaking.users.delete(userId);
    speaking.emit("end", userId);
    return lastFrameAt;
  }
}

/** Opus decoding as passthrough, as test/audio/voiceSubscriptions.test.ts does, so pushed PCM reaches the recorder. */
export function passthroughOpus(actual: typeof PrismMedia) {
  return {
    ...actual,
    opus: {
      ...actual.opus,
      Decoder: class PassthroughDecoder extends PassThrough {},
    },
  };
}
