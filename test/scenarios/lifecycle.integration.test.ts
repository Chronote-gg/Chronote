/** @jest-environment node */
import type { VoiceConnection } from "@discordjs/voice";
import type * as MeetingStart from "../../src/services/meetingStart";
import type * as MeetingClose from "../../src/services/meetingClose";
import type * as MeetingLease from "../../src/services/meetingLease";
import type * as MeetingFinish from "../../src/services/meetingFinish";
import type * as MeetingFinishRepository from "../../src/repositories/meetingFinishRepository";
import type * as MeetingHistoryTransitions from "../../src/repositories/meetingHistoryTransitions";
import type * as CheckpointCapture from "../../src/services/recordingCheckpointCapture";
import type * as CheckpointService from "../../src/services/recordingCheckpointService";
import type * as Audio from "../../src/audio";
import type * as MeetingConfig from "../../src/services/meetingConfigService";
import type * as MeetingFinishInput from "../../src/services/meetingFinishInput";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import { Collection, type Client } from "discord.js";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeetingInitOptions } from "../../src/meetings";
import { removeGeneratedMeetingTemp } from "../fixtures/meetingTemp";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import {
  addFinishChannels,
  FINISH_GUILD_ID,
  FINISH_SPEAKER,
  FINISH_TEXT_CHANNEL_ID,
  FINISH_VOICE_CHANNEL_ID,
  onlyRow,
} from "./harness/finisher";
import {
  createWorld,
  installWorkerSeams,
  type World,
  type WorkerSeams,
} from "./harness/world";

const INSTANCE = "scenario-worker-a";
const MEETING = "scenario-lifecycle-meeting";
const TRANSCRIPT = "Synthetic speaker: we agreed to ship on Friday.";
/** 20 ms of 48 kHz stereo 16-bit PCM, the frame size the capture receives. */
const PCM_FRAME_BYTES = 3840;
const PCM_FRAMES = 1500;

type Modules = {
  seams: WorkerSeams;
  start: typeof MeetingStart;
  close: typeof MeetingClose;
  lease: typeof MeetingLease;
  finish: typeof MeetingFinish;
  bindings: typeof MeetingFinishRepository & typeof MeetingHistoryTransitions;
  capture: typeof CheckpointCapture;
  checkpoints: typeof CheckpointService;
  audio: typeof Audio;
  config: typeof MeetingConfig;
  input: typeof MeetingFinishInput;
};

function loadWorker(world: World): Promise<Modules> {
  return new Promise((resolve, reject) => {
    jest
      .isolateModulesAsync(async () => {
        const seams = installWorkerSeams(world, {
          instanceId: INSTANCE,
          release: 1,
        });
        const [
          start,
          close,
          lease,
          finish,
          finishRepository,
          transitions,
          capture,
          checkpoints,
          audio,
          config,
          input,
        ] = await seams.run(() =>
          Promise.all([
            import("../../src/services/meetingStart"),
            import("../../src/services/meetingClose"),
            import("../../src/services/meetingLease"),
            import("../../src/services/meetingFinish"),
            import("../../src/repositories/meetingFinishRepository"),
            import("../../src/repositories/meetingHistoryTransitions"),
            import("../../src/services/recordingCheckpointCapture"),
            import("../../src/services/recordingCheckpointService"),
            import("../../src/audio"),
            import("../../src/services/meetingConfigService"),
            import("../../src/services/meetingFinishInput"),
          ]),
        );
        resolve({
          seams,
          start,
          close,
          lease,
          finish,
          bindings: { ...finishRepository, ...transitions },
          capture,
          checkpoints,
          audio,
          config,
          input,
        });
      })
      .catch(reject);
  });
}

function liveMeeting(
  options: MeetingInitOptions,
  reservation: MeetingData["reservation"],
  ownershipSignal: AbortSignal | undefined,
): MeetingData {
  const startTime = new Date(reservation?.reservedAt ?? Date.now());
  return {
    meetingId: options.meetingId ?? MEETING,
    guildId: FINISH_GUILD_ID,
    sessionMode: "meeting",
    reservation,
    ownershipSignal,
    connection: { synthetic: "connection" } as unknown as VoiceConnection,
    startTime,
    finishing: false,
    finished: false,
    setFinished: () => undefined,
    isAutoRecording: false,
    chatLog: [],
    participants: new Map([[FINISH_SPEAKER.id, FINISH_SPEAKER]]),
    recordingCaptureState: {
      kind: "capturing",
      startedAt: startTime.toISOString(),
    },
  } as unknown as MeetingData;
}

let world: World;

beforeEach(async () => {
  world = await createWorld();
  addFinishChannels(world);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

const generated: Array<{ meetingId: string }> = [];

afterEach(async () => {
  jest.useRealTimers();
  for (const meeting of generated.splice(0))
    await removeGeneratedMeetingTemp(meeting);
  jest.restoreAllMocks();
  // A capture failure loads close lazily, after the worker's isolated registry is gone; that
  // caches this world's mocked modules in the shared registry, where the next worker would find them.
  jest.resetModules();
  await world.dispose();
});

const CAPTURE_FAILURE_NOTICE =
  "Recording stopped because audio could not be safely saved. Some recent audio may be unavailable.";
/** Past the capture's 60 second unsaved-audio limit. */
const AFTER_UNSAVED_LIMIT_MS = 61_000;

/**
 * A recording as `buildMeetingSession` leaves it once audio flows, with one
 * transcribed audio file. The start's voice join and session build stay
 * stubbed: the harness has no worker entry to drive a real voice session yet.
 */
async function recordingMeeting(
  w: Modules,
  options: MeetingInitOptions,
  reservation: MeetingData["reservation"],
  ownershipSignal: AbortSignal | undefined,
  textChannel: { send: jest.Mock },
): Promise<MeetingData> {
  const meeting = liveMeeting(options, reservation, ownershipSignal);
  const startedAt = meeting.startTime.getTime();
  const guild = {
    id: FINISH_GUILD_ID,
    name: "Scenario Guild",
    description: "",
    roles: new Collection(),
    scheduledEvents: new Collection(),
    channels: new Collection(),
    members: { cache: new Collection() },
    client: {},
  };
  Object.assign(meeting, {
    channelId: FINISH_VOICE_CHANNEL_ID,
    textChannel,
    guild,
    voiceChannel: { id: FINISH_VOICE_CHANNEL_ID, name: "Voice", guild },
    creator: { id: FINISH_SPEAKER.id },
    attendance: new Set([`<@${FINISH_SPEAKER.id}>`]),
    captureStartedAt: meeting.startTime,
    transcribeMeeting: true,
    generateNotes: true,
    runtimeConfig: await w.config.resolveMeetingRuntimeConfig({
      guildId: FINISH_GUILD_ID,
      channelId: FINISH_VOICE_CHANNEL_ID,
      userId: FINISH_SPEAKER.id,
    }),
    audioData: {
      currentSnippets: new Map(),
      audioFiles: [
        {
          userId: FINISH_SPEAKER.id,
          timestamp: startedAt + 1_000,
          transcript: TRANSCRIPT,
          processing: false,
          audioOnlyProcessing: false,
          processingPromise: Promise.resolve(),
        },
      ],
    },
  });
  return meeting;
}

/** Starts a recording through the real start and attaches the production checkpoint capture. */
async function startRecording(
  w: Modules,
  textChannel: { send: jest.Mock },
): Promise<MeetingData> {
  const meetingId = `generated-${randomUUID()}`;
  generated.push({ meetingId });
  let meeting: MeetingData | undefined;
  const { startMeetingSession } = w.start.createMeetingStart({
    lease: w.lease,
    history: w.bindings.getMeetingHistoryTransitionRepository(),
    requestCaptureProtection: async () => undefined,
    releaseCaptureProtection: () => undefined,
    joinVoice: async () =>
      ({ synthetic: "connection" }) as unknown as VoiceConnection,
    leaveVoice: () => undefined,
    async buildMeetingSession(
      options,
      reservation,
      _connection,
      _signal,
      hooks,
    ) {
      meeting = await recordingMeeting(
        w,
        options,
        reservation,
        hooks?.ownershipSignal,
        textChannel,
      );
      hooks?.onReceiving?.();
      return meeting;
    },
    disposeFailedSession: async () => true,
    startDeadline: () => new AbortController().signal,
    captureEndHandlers: () => ({
      onLost: () => undefined,
      onCapReached: () => undefined,
    }),
    endMeeting: () => undefined,
    indexMeeting: async () => undefined,
    nowMs: Date.now,
  });

  await w.seams.run(() =>
    startMeetingSession({
      meetingId,
      guild: { id: FINISH_GUILD_ID },
      voiceChannel: { id: FINISH_VOICE_CHANNEL_ID, name: "Voice" },
      textChannel: { id: FINISH_TEXT_CHANNEL_ID },
      creator: { id: FINISH_SPEAKER.id },
      transcribeMeeting: true,
      generateNotes: true,
    } as unknown as MeetingInitOptions),
  );
  const live = meeting;
  if (!live) throw new Error("expected a live meeting");
  expect(await onlyRow(world)).toMatchObject({
    status: "in_progress",
    lifecycleVersion: 2,
    executionVersion: 1,
  });
  // The production capture: its content checkpoints are what the normal loader drains.
  await w.seams.run(() => w.audio.ensureRecordingCheckpointCapture(live));
  const capture = live.recordingCapture;
  if (!capture) throw new Error("expected a checkpoint capture");
  await w.seams.run(async () => {
    capture.push(
      `user:${FINISH_SPEAKER.id}`,
      Buffer.alloc(PCM_FRAME_BYTES * PCM_FRAMES, 1),
      live.startTime.getTime(),
    );
    await live.recordingContentTask;
    await capture.settled();
  });
  return live;
}

/** Closes through the real close steps; only voice, the nickname and eligibility are stubbed. */
async function closeRecording(w: Modules, live: MeetingData) {
  const started: Array<{ owner: string }> = [];
  const { closeMeeting } = w.close.createMeetingClose({
    lease: w.lease,
    finish: w.bindings.getMeetingFinishRepository(),
    stopCapture: w.close.stopCapture,
    // No voice connection exists without the worker entry; leaving it is a no-op here.
    leaveVoice: () => undefined,
    dropVoiceLocally: () => undefined,
    // The nickname needs a guild member the harness does not model.
    restoreNickname: async () => true,
    flushCapture: w.close.flushCapture,
    prepareLocalFinish: w.close.prepareLocalFinish,
    retireCapture: w.close.retireCapture,
    dropMeeting: w.close.dropMeeting,
    liveMeetings: () => [],
    releaseCaptureProtection: () => undefined,
    // The worker registry that makes a worker eligible is wired by the worker lifecycle task.
    isEligible: () => true,
    isShuttingDown: () => false,
    instanceId: () => INSTANCE,
    // The finisher registers the real starter in the worker lifecycle task; the test runs the finish itself.
    localFinishStarter: () => async (_closed, owner) => {
      started.push({ owner });
      // The test runs the normal loader itself, which ends the encoder.
      return true;
    },
    // The meeting is built by hand with no encoder.
    endEncoder: async () => undefined,
    nowMs: Date.now,
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => clearTimeout(timer), {
          once: true,
        });
      }),
  });
  await w.seams.run(() =>
    closeMeeting(live, {
      endReason: "button",
      endTriggeredByUserId: FINISH_SPEAKER.id,
    }),
  );
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
  expect(started).toHaveLength(1);
  const closed = await onlyRow(world);
  expect(closed).toMatchObject({
    status: "processing",
    endReason: "button",
    endTriggeredByUserId: FINISH_SPEAKER.id,
    capture: { kind: "complete" },
    finish: { owner: started[0].owner },
  });
  return { closed, owner: started[0].owner };
}

/** The local finish: the pipeline with the real normal loader. */
async function finishNormally(
  w: Modules,
  live: MeetingData,
  closed: MeetingHistory,
  owner: string,
): Promise<FinishInput | undefined> {
  const client = { users: { cache: new Map() } } as unknown as Client;
  let loaded: FinishInput | undefined;
  await w.seams.run(() =>
    w.finish.finishMeeting(
      {
        key: {
          guildId: closed.guildId,
          channelId_timestamp: closed.channelId_timestamp,
        },
        meetingId: closed.meetingId,
        owner,
        history: closed,
      },
      async (signal) => {
        loaded = await w.input.loadNormalFinishInput(live, client, signal);
        return loaded;
      },
    ),
  );
  return loaded;
}

function scriptNotes() {
  world.openai.script(
    "text",
    "## Decisions\n- Ship on Friday.",
    JSON.stringify({
      summarySentence: "The team agreed to ship on Friday.",
      summaryLabel: "Ship Friday",
    }),
  );
}

test("a recording with speech closes and finishes through the normal loader, and no capture failure follows", async () => {
  // Time flows with the real clock, so DynamoDB calls work, and can be jumped past the unsaved limit.
  jest.useFakeTimers({
    advanceTimers: true,
    doNotFake: ["nextTick", "setImmediate", "queueMicrotask"],
  });
  scriptNotes();
  const w = await loadWorker(world);
  const textChannel = { send: jest.fn(async () => undefined) };
  const live = await startRecording(w, textChannel);
  const { closed, owner } = await closeRecording(w, live);

  const loaded = await finishNormally(w, live, closed, owner);

  expect(loaded?.source).toBe("normal");
  expect(loaded?.transcript).toContain("ship on Friday");
  const finished = await onlyRow(world);
  expect(finished).toMatchObject({
    status: "complete",
    endReason: "button",
    recovery: { disposition: "done", stage: "delivery" },
  });
  expect(finished.notes).toBeTruthy();
  expect(finished.notesMessageIds).toHaveLength(1);
  const posted = [...world.discord.rest.messages.values()].filter(
    (message) => message.channel_id === FINISH_TEXT_CHANNEL_ID,
  );
  expect(posted.length).toBeGreaterThan(0);

  await jest.advanceTimersByTimeAsync(AFTER_UNSAVED_LIMIT_MS);
  expect(live.recordingPreservationFailure).toBeUndefined();
  expect(textChannel.send).not.toHaveBeenCalledWith(CAPTURE_FAILURE_NOTICE);
  expect(await onlyRow(world)).toMatchObject({ status: "complete" });
});

const FINAL_WORDS = "One more thing before we stop: the release notes.";
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const SPEECH_SECONDS = 2;
const TONE_HZ = 220;
const TONE_AMPLITUDE = 8_000;

/** A loud tone, so the snippet passes the silence and loudness gates as speech would. */
function spokenPcm(): Buffer {
  const samples = SAMPLE_RATE * SPEECH_SECONDS;
  const pcm = Buffer.alloc(samples * CHANNELS * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(
      TONE_AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * index) / SAMPLE_RATE),
    );
    pcm.writeInt16LE(value, index * 4);
    pcm.writeInt16LE(value, index * 4 + 2);
  }
  return pcm;
}

test("speech still open when stop is pressed reaches the transcript the notes input carries", async () => {
  scriptNotes();
  world.openai.script("transcription", FINAL_WORDS);
  const w = await loadWorker(world);
  const live = await startRecording(w, {
    send: jest.fn(async () => undefined),
  });
  // The final pass would spend the scripted notes responses; this test is about the snippet hand-off.
  if (live.runtimeConfig)
    live.runtimeConfig.transcription.finalPassEnabled = false;
  const pcm = spokenPcm();
  live.audioData.currentSnippets.set(FINISH_SPEAKER.id, {
    userId: FINISH_SPEAKER.id,
    timestamp: Date.now() - SPEECH_SECONDS * 1_000,
    chunks: [pcm],
    audioBytes: pcm.length,
  });
  const { closed, owner } = await closeRecording(w, live);

  const loaded = await finishNormally(w, live, closed, owner);

  expect(loaded?.notesInput.finalTranscript).toContain(FINAL_WORDS);
  expect(loaded?.transcript).toContain(FINAL_WORDS);
  expect(await onlyRow(world)).toMatchObject({ status: "complete" });
});

test("close waits for a capture-failure save, so the pieces pending at the failure are published and their coverage recorded", async () => {
  const w = await loadWorker(world);
  const textChannel = { send: jest.fn(async () => undefined) };
  const live = await startRecording(w, textChannel);
  const capture = live.recordingCapture;
  if (!capture) throw new Error("expected a checkpoint capture");
  const before = (await onlyRow(world)).checkpoint?.revision ?? 0;
  capture.push(
    `user:${FINISH_SPEAKER.id}`,
    Buffer.alloc(PCM_FRAME_BYTES * 50, 1),
    live.startTime.getTime() + 30_000,
  );

  // The storage failure path: fence the capture and start the failure's save, which closes the meeting.
  await w.seams.run(async () => {
    capture.interrupt();
    await w.close.closeMeeting(live, { endReason: "unknown", abnormal: true });
  });

  expect(live.recordingPreservationFailure).toMatchObject({
    preservation: "confirmed",
    coverage: { kind: "verified" },
  });
  const row = await onlyRow(world);
  expect(row.checkpoint?.revision).toBeGreaterThan(before);
  expect(row.status).toBe("processing");
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("checkpoints are saved during a recording started through the new path", async () => {
  const w = await loadWorker(world);
  let meeting: MeetingData | undefined;
  const { startMeetingSession } = w.start.createMeetingStart({
    lease: w.lease,
    history: w.bindings.getMeetingHistoryTransitionRepository(),
    requestCaptureProtection: async () => undefined,
    releaseCaptureProtection: () => undefined,
    joinVoice: async () =>
      ({ synthetic: "connection" }) as unknown as VoiceConnection,
    leaveVoice: () => undefined,
    async buildMeetingSession(
      options,
      reservation,
      _connection,
      _signal,
      hooks,
    ) {
      meeting = liveMeeting(options, reservation, hooks?.ownershipSignal);
      Object.assign(meeting, {
        channelId: FINISH_TEXT_CHANNEL_ID,
        voiceChannel: { id: FINISH_VOICE_CHANNEL_ID },
        captureStartedAt: meeting.startTime,
        transcribeMeeting: true,
        generateNotes: true,
      });
      hooks?.onReceiving?.();
      return meeting;
    },
    disposeFailedSession: async () => true,
    startDeadline: () => new AbortController().signal,
    captureEndHandlers: () => ({
      onLost: () => undefined,
      onCapReached: () => undefined,
    }),
    endMeeting: () => undefined,
    indexMeeting: async () => undefined,
    nowMs: Date.now,
  });
  await w.seams.run(() =>
    startMeetingSession({
      meetingId: MEETING,
      guild: { id: FINISH_GUILD_ID },
      voiceChannel: { id: FINISH_VOICE_CHANNEL_ID, name: "Voice" },
      textChannel: { id: FINISH_TEXT_CHANNEL_ID },
      creator: { id: FINISH_SPEAKER.id },
      transcribeMeeting: true,
      generateNotes: true,
    } as unknown as MeetingInitOptions),
  );
  const live = meeting;
  if (!live?.ownershipSignal) throw new Error("expected a capture signal");
  const startedAt = live.startTime.getTime();
  live.recordingCapture = w.capture.createRecordingCheckpointCapture({
    directory: mkdtempSync(path.join(os.tmpdir(), "scenario-capture-")),
    startedAt,
    signal: live.ownershipSignal,
    commit: async (artifacts, signal) =>
      (
        await w.checkpoints.appendMeetingCheckpointArtifacts(
          live,
          artifacts,
          signal,
        )
      ).kind === "committed",
    stopCapture: () => {
      throw new Error("Unexpected scenario capture cutoff");
    },
  });

  await w.seams.run(async () => {
    live.recordingCapture!.push(
      `user:${FINISH_SPEAKER.id}`,
      Buffer.alloc(PCM_FRAME_BYTES * PCM_FRAMES, 1),
      startedAt,
    );
    await live.recordingCapture!.settled();
  });

  const row = await onlyRow(world);
  expect(row.status).toBe("in_progress");
  expect(row.checkpoint?.revision).toBeGreaterThanOrEqual(1);
  expect(
    [...world.storage.objects.keys()].some((key) =>
      key.startsWith(row.checkpoint!.artifactFolder),
    ),
  ).toBe(true);
  expect(live.ownershipSignal.aborted).toBe(false);
  // Stops the lease renewal, which would otherwise outlive this suite's tables.
  live.recordingCapture?.retire();
  const reservation = live.reservation;
  if (reservation)
    await w.seams.run(() => w.lease.releaseSessionLease(reservation));
});
