import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { format } from "node:util";
import { SnowflakeUtil } from "discord.js";
import {
  LEGACY_STANDBY_UNREADABLE_LOG,
  MEETING_ABANDONED_LOG,
  MEETING_DELIVERY_FAILED_LOG,
  MEETING_FINISH_FAILED_LOG,
  MEETING_STUCK_LOG,
  TASK_PROTECTION_FAILED_LOG,
} from "../../../src/metrics";
import { renderMeetingDelivery } from "../../../src/services/meetingDelivery";
import { getMeetingTempDir } from "../../../src/services/tempFileService";
import type { MeetingHistory } from "../../../src/types/db";
import { recordingManifestSchema } from "../../../src/types/recordingCheckpoint";
import type {
  MeetingControlCommand,
  MeetingControlCommandInput,
  MeetingControlCommandType,
} from "../../../src/types/meetingControl";
import type { FakeMember } from "./fakeDiscord";
import {
  addFinishChannels,
  FINISH_GUILD_ID,
  FINISH_SPEAKER,
  FINISH_TEXT_CHANNEL_ID,
  FINISH_VOICE_CHANNEL_ID,
} from "./finisher";
import { FRAME_BYTES, FRAME_MS } from "./fakeVoice";
import {
  createWorld,
  type ScenarioWorker,
  type World,
  type WorkerOptions,
} from "./world";

const POLL_MS = 50;
const TEMP_REMOVE_RETRIES = 20;
const WAIT_MS = 30_000;
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
/** How long each `speak` turn lasts, on the real clock. */
export const SPEECH_SECONDS = 2;
const TONE_HZ = 220;
const TONE_AMPLITUDE = 8_000;
export const MS_PER_SECOND = 1000;
export const WEEK_MS = 7 * 24 * 3_600_000;
/** The capture's piece seal, scaled down from 30 seconds so a dead worker's speech is saved in about a second. */
const SCENARIO_SEGMENT_MS = 1_000;
/** A low-confidence snippet is transcribed twice, prompted and unprompted. */
const SNIPPET_TRANSCRIPTIONS = 2;
/** The notice an interrupted meeting's notes open with. */
export const INTERRUPTED_NOTICE = "recording was interrupted";
/** What that notice says when no saved audio piece proves its timing, as is normal for jittered audio. */
export const UNKNOWN_COVERAGE_NOTICE = "Saved recording coverage is unknown.";
/** Added when nobody saw the capture end, as for a worker that died. */
export const UNKNOWN_END_NOTICE = "The exact recording end time is unknown.";
const MODEL_REPLIES = 40;
const CONSOLE_METHODS = ["log", "warn", "info", "debug", "error"] as const;
const LONG_NOTES_LINES = 200;
/** The summary label every scripted reply carries; it marks the summary card. */
export const SUMMARY_LABEL = "Ship Friday";
const CONTROL_COMMAND_TABLE = "MeetingControlCommandTable";
const CONTROL_COMMAND_TTL_SECONDS = 15 * 60;

function isControlCommand(
  item: Record<string, unknown> | undefined,
): item is MeetingControlCommand {
  return item !== undefined && "requestId" in item && "queueStatus" in item;
}

/** Every log line a CloudWatch metric filter turns into an alarm. */
const ALARM_LOGS = [
  MEETING_STUCK_LOG,
  MEETING_ABANDONED_LOG,
  MEETING_FINISH_FAILED_LOG,
  MEETING_DELIVERY_FAILED_LOG,
  TASK_PROTECTION_FAILED_LOG,
  LEGACY_STANDBY_UNREADABLE_LOG,
];

/** The first scenario server; its ids are the finisher harness's. */
export const SERVER_A = {
  guildId: FINISH_GUILD_ID,
  textChannelId: FINISH_TEXT_CHANNEL_ID,
  voiceChannelId: FINISH_VOICE_CHANNEL_ID,
  speaker: FINISH_SPEAKER,
};
/** A second, unrelated scenario server. */
export const SERVER_B = {
  guildId: "200000000000000021",
  textChannelId: "200000000000000022",
  voiceChannelId: "200000000000000023",
  speaker: { id: "300000000000000021", username: "Speaker B" },
};
export type ScenarioServer = typeof SERVER_A;

/** A loud tone, so the snippet passes the silence and loudness gates as speech would. */
export function spokenPcm(seconds = SPEECH_SECONDS): Buffer {
  // Whole frames, so every frame the fake voice delivers is a full 20 ms.
  const frames = Math.round(
    (SAMPLE_RATE * seconds * CHANNELS * BYTES_PER_SAMPLE) / FRAME_BYTES,
  );
  const samples = (frames * FRAME_BYTES) / (CHANNELS * BYTES_PER_SAMPLE);
  const pcm = Buffer.alloc(samples * CHANNELS * BYTES_PER_SAMPLE);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE),
    );
    pcm.writeInt16LE(value, index * CHANNELS * BYTES_PER_SAMPLE);
    pcm.writeInt16LE(value, index * CHANNELS * BYTES_PER_SAMPLE + 2);
  }
  return pcm;
}

export const pause = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  description: string,
  waitMs = WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const value = await read();
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    if (value !== undefined) return value;
    await pause(POLL_MS);
  }
}

/** A gate a fake's hook awaits: calls are held from `close` until `open`. */
export function gate() {
  let opened: Promise<void> = Promise.resolve();
  let open = () => {};
  return {
    close() {
      opened = new Promise((resolve) => {
        open = resolve;
      });
    },
    open: () => open(),
    wait: () => opened,
  };
}

export const epochSeconds = () => Math.floor(Date.now() / MS_PER_SECOND);

/**
 * One world per test with its workers, the shared fakes and the outside
 * events: every interaction and voice update goes to every worker started,
 * as Discord delivers them to every connected client.
 */
export class Scenario {
  readonly workers: ScenarioWorker[] = [];
  private readonly stopped = new Set<ScenarioWorker>();
  /** Console lines from the test and from workers still alive; a dead worker logs nothing anyone sees. */
  private readonly logged: { method: string; first: string }[] = [];

  private constructor(readonly world: World) {}

  static async create(): Promise<Scenario> {
    const world = await createWorld();
    addFinishChannels(world);
    world.discord.addGuild(SERVER_B.guildId, "Scenario Guild B");
    world.discord.addChannel({
      id: SERVER_B.textChannelId,
      guildId: SERVER_B.guildId,
      name: "notes",
      kind: "text",
    });
    world.discord.addChannel({
      id: SERVER_B.voiceChannelId,
      guildId: SERVER_B.guildId,
      name: "Voice",
      kind: "voice",
    });
    world.discord.addMember(SERVER_B.guildId, SERVER_B.speaker);
    const scenario = new Scenario(world);
    for (const method of CONSOLE_METHODS)
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        if (world.discord.workers.getStore()?.alive === false) return;
        scenario.logged.push({ method, first: String(args[0]) });
        if (process.env.SCENARIO_DEBUG)
          process.stderr.write(`[${method}] ${format(...args)}\n`);
      });
    return scenario;
  }

  async startWorker(options: WorkerOptions): Promise<ScenarioWorker> {
    const worker = await this.world.startWorker({
      ...options,
      lifecycle: {
        checkpointSegmentMs: SCENARIO_SEGMENT_MS,
        ...options.lifecycle,
      },
    });
    this.workers.push(worker);
    return worker;
  }

  /** Workers still running: not stopped by SIGTERM in the test and not crashed. */
  live(): ScenarioWorker[] {
    return this.workers.filter((worker) => !this.stopped.has(worker));
  }

  /** The worker recording `row`, by the owner the start wrote. */
  recorder(row: Pick<MeetingHistory, "ownerInstanceId">): ScenarioWorker {
    const worker = this.workers.find(
      (candidate) => candidate.instanceId === row.ownerInstanceId,
    );
    if (!worker) throw new Error(`No scenario worker ${row.ownerInstanceId}`);
    return worker;
  }

  /** The worker's own shutdown, as ECS sends SIGTERM. */
  async sigterm(worker: ScenarioWorker): Promise<void> {
    this.stopped.add(worker);
    await worker.sigterm();
  }

  /**
   * The process dies: no close, no shutdown. What it simulates: from now on
   * nothing the worker does reaches the world. Its DynamoDB, storage, OpenAI,
   * Discord REST and ECS agent calls throw, its voice connection sends no leave
   * when destroyed, and its log lines are dropped, so it raises no alarm. What
   * it does not: the worker's timers and promises keep running inside this
   * process until teardown stops them, so in-memory state is not lost the way
   * a real exit loses it, and Discord does not keep a dead bot in voice.
   */
  crash(worker: ScenarioWorker): void {
    this.stopped.add(worker);
    worker.kill();
  }

  /** One voice join, delivered to every live worker at the same instant, as the gateway does. */
  async joinVoice(server: ScenarioServer, member: FakeMember = server.speaker) {
    await Promise.all(
      this.live().map((worker) =>
        worker.joinVoice(server.guildId, server.voiceChannelId, member),
      ),
    );
  }

  async leaveVoice(
    server: ScenarioServer,
    member: FakeMember = server.speaker,
  ) {
    await Promise.all(
      this.live().map((worker) => worker.leaveVoice(server.guildId, member)),
    );
  }

  /** One slash command, delivered to every live worker at once. */
  async command(
    name: string,
    server: ScenarioServer,
    options: object = {},
    to: ScenarioWorker[] = this.live(),
  ) {
    const id = SnowflakeUtil.generate().toString();
    const [first] = await Promise.all(
      to.map((worker) => worker.command(name, options, server.speaker, id)),
    );
    return { id, responses: first?.responses ?? [] };
  }

  /** One button press on `messageId`, delivered to every live worker at once. */
  async button(
    customId: string,
    messageId: string,
    server: ScenarioServer,
    to: ScenarioWorker[] = this.live(),
  ) {
    const id = SnowflakeUtil.generate().toString();
    const [first] = await Promise.all(
      to.map((worker) =>
        worker.button(customId, messageId, server.speaker, id),
      ),
    );
    return { id, responses: first?.responses ?? [] };
  }

  /** One modal submission, delivered to every live worker at once. */
  async modal(
    customId: string,
    fields: Record<string, string>,
    server: ScenarioServer,
    to: ScenarioWorker[] = this.live(),
  ) {
    const id = SnowflakeUtil.generate().toString();
    const [first] = await Promise.all(
      to.map((worker) => worker.modal(customId, fields, server.speaker, id)),
    );
    return { id, responses: first?.responses ?? [] };
  }

  /** Speech the worker in voice receives; resolves with the time its last frame was delivered. */
  speak(worker: ScenarioWorker, server: ScenarioServer, seconds?: number) {
    return worker.speak(server.guildId, server.speaker.id, spokenPcm(seconds));
  }

  /** The row's checkpoint manifest, as recovery would read it. */
  async savedManifest(server: ScenarioServer, meetingId: string) {
    const row = await this.row(server, meetingId);
    const bytes =
      row.checkpoint &&
      this.world.storage.objects.get(row.checkpoint.manifest.key);
    return bytes
      ? recordingManifestSchema.parse(JSON.parse(bytes.toString("utf8")))
      : undefined;
  }

  /** The audio pieces the row's checkpoint manifest lists. */
  async savedAudio(server: ScenarioServer, meetingId: string) {
    const manifest = await this.savedManifest(server, meetingId);
    return (manifest?.artifacts ?? []).filter(
      (artifact) => artifact.kind === "audio",
    );
  }

  /** When the latest saved piece's last chunk arrived, by the capture's own clock. */
  private async lastSavedArrival(server: ScenarioServer, meetingId: string) {
    const manifest = await this.savedManifest(server, meetingId);
    const startedAt = manifest?.capture.captureStartedAt;
    if (!manifest || !startedAt) return undefined;
    const offsets = manifest.artifacts.flatMap((artifact) =>
      artifact.kind === "audio" && artifact.timing
        ? [artifact.timing.observedLastOffsetMs]
        : [],
    );
    return offsets.length
      ? Date.parse(startedAt) + Math.max(...offsets)
      : undefined;
  }

  /**
   * Speech the recording worker has transcribed and saved, so another worker
   * can recover it once this one is gone: the row's checkpoint manifest lists
   * the piece holding the turn's last frame. Resolves with the time that frame
   * was delivered.
   */
  async speakAndSave(
    worker: ScenarioWorker,
    meetingId: string,
    server: ScenarioServer = SERVER_A,
  ) {
    const transcriptions = () =>
      this.world.openai.calls.filter((call) => call.kind === "transcription")
        .length;
    const transcribed = transcriptions();
    const lastFrameAt = await this.speak(worker, server);
    await until(
      () =>
        transcriptions() >= transcribed + SNIPPET_TRANSCRIPTIONS
          ? true
          : undefined,
      "speech transcribed",
    );
    // The worker stamps a chunk when it arrives, at most one frame before the fake records it sent.
    await until(
      async () =>
        Number(await this.lastSavedArrival(server, meetingId)) >=
        lastFrameAt - FRAME_MS
          ? true
          : undefined,
      "the last frame listed in the checkpoint manifest",
    );
    return lastFrameAt;
  }

  /** Every state the row passes through, read every 50 ms until `stop`. */
  sampleRow(server: ScenarioServer, meetingId: string) {
    const seen: { atMs: number; row: MeetingHistory }[] = [];
    let sampling = true;
    const done = (async () => {
      while (sampling) {
        const row = (await this.rows(server)).find(
          (candidate) => candidate.meetingId === meetingId,
        );
        if (row) seen.push({ atMs: Date.now(), row });
        await pause(POLL_MS);
      }
    })();
    return {
      seen,
      rows: () => seen.map((sample) => sample.row),
      /** Every finish claim owner seen, in order. */
      owners: () => seen.flatMap(({ row }) => row.finish?.owner ?? []),
      async stop() {
        sampling = false;
        await done;
      },
    };
  }

  /** The channel rule `/autorecord` saves, as config overrides. */
  async enableAutoRecord(server: ScenarioServer = SERVER_A) {
    const scopeId = `channel#${server.guildId}#${server.voiceChannelId}`;
    for (const [configKey, value] of [
      ["autorecord.enabled", true],
      ["notes.channelId", server.textChannelId],
    ] as const)
      await this.world.rows.put("ConfigOverridesTable", {
        scopeId,
        configKey,
        value,
        updatedAt: new Date().toISOString(),
        updatedBy: server.speaker.id,
      });
  }

  /** The interaction's own responses (callbacks and webhook edits), from every worker. */
  responsesTo(id: string) {
    return this.world.discord.rest
      .requests()
      .filter(
        (call) =>
          call.path.startsWith(`/interactions/${id}/`) ||
          call.path.includes(`/scenario-token-${id}`),
      );
  }

  messages(server: ScenarioServer) {
    return [...this.world.discord.rest.messages.values()].filter(
      (message) => message.channel_id === server.textChannelId,
    );
  }

  /** The id of the recording message whose End button belongs to `meetingId`'s row. */
  async startMessageOf(server: ScenarioServer, meetingId: string) {
    const row = await until(
      async () =>
        (await this.world.rows.history(server.guildId)).find(
          (candidate) =>
            candidate.meetingId === meetingId && candidate.startMessageId,
        ),
      "start message recorded",
    );
    return String(row.startMessageId);
  }

  rows(server: ScenarioServer) {
    return this.world.rows.history(server.guildId);
  }

  row(server: ScenarioServer, meetingId: string) {
    return until(
      async () =>
        (await this.rows(server)).find((row) => row.meetingId === meetingId),
      `row ${meetingId}`,
    );
  }

  rowWith(
    server: ScenarioServer,
    predicate: (row: MeetingHistory) => boolean,
    description: string,
    waitMs?: number,
  ) {
    return until(
      async () => (await this.rows(server)).find(predicate),
      description,
      waitMs,
    );
  }

  /** Starts a recording with `/startmeeting` from the server's speaker and waits for its row to be in progress. */
  async startRecording(
    server: ScenarioServer,
    known: string[] = [],
    to: ScenarioWorker[] = this.live(),
  ) {
    await this.joinVoice(server);
    const interaction = await this.command("startmeeting", server, {}, to);
    const row = await this.rowWith(
      server,
      (candidate) =>
        candidate.status === "in_progress" &&
        !known.includes(candidate.meetingId),
      "recording started",
    );
    return { row, interaction };
  }

  /** Delivered: a terminal status and the done marker. On a timeout the error names the row's last state. */
  async delivered(server: ScenarioServer, meetingId: string, waitMs?: number) {
    return this.rowWith(
      server,
      (row) =>
        row.meetingId === meetingId &&
        row.recovery?.disposition === "done" &&
        row.finish === undefined,
      `meeting ${meetingId} delivered`,
      waitMs,
    ).catch(async (error: unknown) => {
      const row = (await this.rows(server)).find(
        (candidate) => candidate.meetingId === meetingId,
      );
      throw new Error(
        `${String(error)}; last state ${JSON.stringify({
          status: row?.status,
          capture: row?.capture,
          finish: row?.finish,
          processing: row?.processing,
          recovery: row?.recovery,
        })}`,
      );
    });
  }

  /** No live lease: absent, or expired as a dead worker leaves it. */
  leaseFree(server: ScenarioServer = SERVER_A, waitMs?: number) {
    return until(
      async () => {
        const lease = await this.world.rows.lease(server.guildId);
        return !lease || lease.leaseExpiresAt < epochSeconds()
          ? true
          : undefined;
      },
      "lease free",
      waitMs,
    );
  }

  leaseGone(server: ScenarioServer = SERVER_A, waitMs?: number) {
    return until(
      async () =>
        (await this.world.rows.lease(server.guildId)) ? undefined : true,
      "lease released",
      waitMs,
    );
  }

  /**
   * Valid as every text reply a finish asks for (final pass, notes, summary,
   * auto-record cancellation), so scenarios do not depend on how many run.
   * `longNotes` pads the reply over many lines, so notes span several messages.
   */
  scriptReplies(options: { longNotes?: boolean } = {}) {
    const padding = options.longNotes
      ? Object.fromEntries(
          Array.from({ length: LONG_NOTES_LINES }, (_, line) => [
            `line${line}`,
            `- Synthetic note line ${line} about a placeholder topic.`,
          ]),
        )
      : {};
    const reply = JSON.stringify(
      {
        edits: [],
        cancel: false,
        summarySentence: "The team agreed to ship on Friday.",
        summaryLabel: SUMMARY_LABEL,
        ...padding,
      },
      null,
      options.longNotes ? 2 : undefined,
    );
    this.world.openai.script(
      "text",
      ...Array.from({ length: MODEL_REPLIES }, () => reply),
    );
  }

  /** A command the portal or MCP queues for the bot, as the API writes it. */
  async queueControl(
    commandType: MeetingControlCommandType,
    server: ScenarioServer,
    input: MeetingControlCommandInput,
    targetOwnerInstanceId?: string,
  ): Promise<string> {
    const createdAt = new Date().toISOString();
    const command: MeetingControlCommand = {
      requestId: randomUUID(),
      queueStatus: "pending",
      commandType,
      userId: server.speaker.id,
      input,
      targetOwnerInstanceId,
      createdAt,
      updatedAt: createdAt,
      expiresAt: epochSeconds() + CONTROL_COMMAND_TTL_SECONDS,
    };
    await this.world.rows.put(CONTROL_COMMAND_TABLE, command);
    return command.requestId;
  }

  async controlCommand(
    requestId: string,
  ): Promise<MeetingControlCommand | undefined> {
    const item = await this.world.rows.get(CONTROL_COMMAND_TABLE, {
      requestId,
    });
    return isControlCommand(item) ? item : undefined;
  }

  /** Alarm log lines emitted so far. */
  alarms(): string[] {
    return this.logged
      .filter(({ method }) => method === "error")
      .map(({ first }) => first)
      .filter((line) => ALARM_LOGS.some((alarm) => line.startsWith(alarm)));
  }

  /** Set by a scenario that expects Discord to refuse a second interaction callback. */
  expectsRejectedCallbacks = false;

  /** Workers still running are shut down; crashed ones too, which only stops their timers. */
  async dispose(): Promise<void> {
    for (const worker of this.workers.splice(0)) await worker.sigterm();
    for (const server of [SERVER_A, SERVER_B])
      for (const row of await this.world.rows.history(server.guildId))
        // Windows keeps a file busy for a moment after a lingering worker's last read of it.
        await rm(getMeetingTempDir(row), {
          recursive: true,
          force: true,
          maxRetries: TEMP_REMOVE_RETRIES,
          retryDelay: POLL_MS,
        });
    jest.restoreAllMocks();
    // A crashed worker's timers outlive the test; what they log belongs to no test.
    for (const method of CONSOLE_METHODS) {
      const original = console[method];
      jest
        .spyOn(console, method)
        .mockImplementation((...args: unknown[]) =>
          this.world.discord.workers.getStore()
            ? undefined
            : original.apply(console, args),
        );
    }
    await this.world.dispose();
    // The product catches the refusal, so it would otherwise pass unnoticed.
    if (!this.expectsRejectedCallbacks)
      expect(this.world.discord.rest.rejectedCallbacks).toBe(0);
  }
}

const bySnowflake = (a: string, b: string) =>
  BigInt(a) < BigInt(b) ? -1 : Number(BigInt(a) > BigInt(b));

/** Delivery's first request edits the start message into the summary card. */
export const isSummaryEdit = (
  call: { method: string; path: string; body: unknown },
  startMessage: string,
  server: ScenarioServer = SERVER_A,
) =>
  call.method === "PATCH" &&
  call.path === `/channels/${server.textChannelId}/messages/${startMessage}` &&
  JSON.stringify(call.body).includes(SUMMARY_LABEL);

/**
 * Each delivered meeting's start message turned into its summary, then each
 * notes chunk once, all recorded on its row; and the channel holds exactly
 * those messages and `otherMessageIds`, in the order posted, nothing else.
 * Returns the delivered meetings' messages.
 */
export function expectDeliveredOnce(
  scenario: Scenario,
  delivered: MeetingHistory | MeetingHistory[],
  otherMessageIds: string[] = [],
) {
  const rows = [delivered].flat();
  const server = rows[0].guildId === SERVER_B.guildId ? SERVER_B : SERVER_A;
  const ids = rows.flatMap((row) => {
    expect(row.summaryMessageId).toBe(row.startMessageId);
    expect(row.notesMessageIds).toHaveLength(
      renderMeetingDelivery(row).notes.length,
    );
    const own = [String(row.summaryMessageId), ...(row.notesMessageIds ?? [])];
    // The row records its messages in the order they were posted.
    expect(own).toEqual([...own].sort(bySnowflake));
    return own;
  });
  const channel = scenario.messages(server);
  expect(channel.map((message) => message.id)).toEqual(
    [...ids, ...otherMessageIds].sort(bySnowflake),
  );
  return channel.filter((message) => ids.includes(message.id));
}

export function embedText(message: { embeds: unknown[]; content: string }) {
  return message.content + JSON.stringify(message.embeds);
}
