import type * as LifecycleTiming from "../../src/services/lifecycleTiming";
import type * as MeetingFinisher from "../../src/services/meetingFinisher";
import type * as MeetingFinish from "../../src/services/meetingFinish";
import type * as MeetingFinishInput from "../../src/services/meetingFinishInput";
import type * as WorkerRegistry from "../../src/services/workerRegistry";
import { renderMeetingDelivery } from "../../src/services/meetingDelivery";
import type { MeetingFinisherDeps } from "../../src/services/meetingFinisher";
import type { MeetingHistory } from "../../src/types/db";
import { formatMeetingCaptureNotice } from "../../src/utils/meetingCaptureNotice";
import { NOTES } from "../services/meetingDelivery.fixture";
import type * as RecoveryFixtures from "../services/meetingRecoveryFixtures";
import {
  addFinishChannels,
  FINISH_GUILD_ID,
  FINISH_TEXT_CHANNEL_ID,
  finishRow,
  onlyRow,
  spokenInput,
} from "./harness/finisher";
import {
  createWorld,
  installWorkerSeams,
  SCENARIO_LIFECYCLE_OVERRIDES,
  type WorkerSeams,
  type World,
} from "./harness/world";

const MS_PER_SECOND = 1000;
/** Claims and the abandoned grace on the scenario clock, so a dead worker's meeting is taken in seconds. */
const FINISHER_OVERRIDES = {
  finishClaimSeconds: 2,
  finishClaimRenewMs: 500,
  abandonedGraceSeconds: 3,
} as const;
const WAIT_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
const MINUTES_AGO = 10 * 60_000;
/** 48 kHz stereo 16-bit PCM. */
const PCM_BYTES_PER_MS = 192;
const SAVED_AUDIO_MS = 5_000;
const SAVED_TEXT = "We agreed to ship the synthetic release on Friday.";
const STRANDED_MEETINGS = 3;
const SUMMARY_JSON = JSON.stringify({
  summarySentence: "The team agreed to ship the synthetic release.",
  summaryLabel: "Synthetic release",
});
const SCRIPTED_TEXT_CALLS = 50;

type LoopWorker = {
  seams: WorkerSeams;
  finisher: typeof MeetingFinisher;
  finish: typeof MeetingFinish;
  input: typeof MeetingFinishInput;
  /** A loop built from this worker's modules with some dependencies replaced. */
  loop(
    overrides: Partial<MeetingFinisherDeps>,
  ): ReturnType<typeof MeetingFinisher.createMeetingFinisherLoop>;
  run<T>(work: () => T): T;
};

/** One worker's finisher, imported in isolation behind that worker's seams, always eligible. */
async function startLoopWorker(
  world: World,
  instanceId: string,
): Promise<LoopWorker> {
  let worker: LoopWorker | undefined;
  await jest.isolateModulesAsync(async () => {
    const seams = installWorkerSeams(world, { instanceId, release: 1 });
    jest.doMock("../../src/services/lifecycleTiming", () => {
      const actual = jest.requireActual<typeof LifecycleTiming>(
        "../../src/services/lifecycleTiming",
      );
      return {
        ...actual,
        LIFECYCLE: {
          ...actual.LIFECYCLE,
          ...SCENARIO_LIFECYCLE_OVERRIDES,
          ...FINISHER_OVERRIDES,
        },
      };
    });
    jest.doMock("../../src/services/workerRegistry", () => ({
      ...jest.requireActual<typeof WorkerRegistry>(
        "../../src/services/workerRegistry",
      ),
      isEligible: () => true,
    }));
    const [finisher, finish, input, bindings, leases] = await seams.run(() =>
      Promise.all([
        import("../../src/services/meetingFinisher"),
        import("../../src/services/meetingFinish"),
        import("../../src/services/meetingFinishInput"),
        import("../../src/repositories/meetingFinishRepository"),
        import("../../src/repositories/meetingLeaseRepository"),
      ]),
    );
    const leaseRepository = leases.getMeetingLeaseRepository();
    worker = {
      seams,
      finisher,
      finish,
      input,
      loop: (overrides) =>
        finisher.createMeetingFinisherLoop({
          repository: bindings.getMeetingFinishRepository(),
          readLease: (guildId, signal) => leaseRepository.read(guildId, signal),
          finish: finish.finishMeeting,
          loadNormal: async () => {
            throw new Error("No local capture in this scenario");
          },
          loadRecovery: (history, signal) =>
            input.loadRecoveryFinishInput(history, signal),
          readCoverage: finisher.manifestCoverageReader(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          isCapturing: () => false,
          // No local capture, so no encoder.
          endEncoder: async () => undefined,
          isEligible: () => true,
          instanceId: () => instanceId,
          nowMs: Date.now,
          every: () => () => undefined,
          ...overrides,
        }),
      run: (work) => seams.run(work),
    };
  });
  if (!worker) throw new Error(`worker ${instanceId} did not start`);
  return worker;
}

async function waitFor(
  description: string,
  done: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

let world: World;

beforeEach(async () => {
  world = await createWorld();
  addFinishChannels(world);
  // Every text call answers with summary JSON, which also reads as notes, so
  // the order of notes and summary calls across workers does not matter.
  world.openai.script(
    "text",
    ...Array.from({ length: SCRIPTED_TEXT_CALLS }, () => SUMMARY_JSON),
  );
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await world.dispose();
});

const channelMessages = () =>
  [...world.discord.rest.messages.values()].filter(
    (message) => message.channel_id === FINISH_TEXT_CHANNEL_ID,
  );
const titles = () =>
  channelMessages().map((message) => {
    const [embed] = message.embeds;
    return embed && typeof embed === "object" && "title" in embed
      ? String(embed.title)
      : "";
  });

/** Kills a worker while it answers its `count`th POST; `refuse` also fails that POST. */
function killOnPost(
  kill: () => void,
  count: number,
  refuse: boolean,
): () => boolean {
  let posts = 0;
  let armed = true;
  world.discord.rest.onPost(() => {
    if (!armed || ++posts < count) return;
    armed = false;
    kill();
    if (refuse) throw new Error("Scenario worker died before posting");
  });
  return () => !armed;
}

/** A meeting whose terminal status and notes were saved before delivery began. */
function savedMeeting(meetingId: string) {
  return finishRow(meetingId, {
    status: "complete",
    notes: NOTES,
    summarySentence: "Synthetic summary.",
    summaryLabel: "Synthetic label",
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
    transcriptS3Key: `scenario/${meetingId}/transcript.json`,
    finish: { attempts: 0, phase: "deliver" },
  });
}

function expectEveryChunkOnce(row: MeetingHistory) {
  const chunks = renderMeetingDelivery(row).notes.map((chunk) =>
    String(chunk.embeds[0]?.title),
  );
  expect(chunks.length).toBeGreaterThan(1);
  const posted = titles();
  for (const title of chunks)
    expect(posted.filter((value) => value === title)).toHaveLength(1);
  expect(row.notesMessageIds).toHaveLength(chunks.length);
  expect(row.recovery?.disposition).toBe("done");
  expect(row.finish).toBeUndefined();
}

const delivered = async () => {
  const row = await onlyRow(world);
  return row.recovery?.disposition === "done" && row.finish === undefined;
};

/** Kills worker A's loop mid-delivery, then lets worker B's loop finish the meeting. */
async function deliverAcrossADeath(postCount: number, refuse: boolean) {
  const a = await startLoopWorker(world, "scenario-worker-a");
  const died = killOnPost(() => a.seams.kill(), postCount, refuse);
  a.run(() => a.finisher.startMeetingFinisher());
  await waitFor("worker A dies", died);
  await waitFor(
    "worker A's attempt ends",
    () => a.finisher.activeFinishCount() === 0,
  );
  await a.finisher.stopMeetingFinisher();
  const posted = channelMessages().length;

  const b = await startLoopWorker(world, "scenario-worker-b");
  b.run(() => b.finisher.startMeetingFinisher());
  await waitFor("worker B delivers the meeting", delivered);
  await waitFor(
    "worker B's attempt ends",
    () => b.finisher.activeFinishCount() === 0,
  );
  await b.finisher.stopMeetingFinisher();
  return posted;
}

/**
 * A meeting recorded by a worker that died mid-capture: its row is still
 * `in_progress` with a checkpoint of five seconds of audio and its transcript,
 * and its lease has lapsed. The checkpoint objects are placed in shared storage.
 */
async function meetingWithCheckpoint(
  options: { startedMsAgo?: number; updatedAt?: string } = {},
) {
  const timestamp = new Date(
    Date.now() - (options.startedMsAgo ?? MINUTES_AGO),
  ).toISOString();
  const bytes = PCM_BYTES_PER_MS * SAVED_AUDIO_MS;
  // Imported fresh so its config reads this world's table prefix.
  let fixtures: typeof RecoveryFixtures | undefined;
  await jest.isolateModulesAsync(async () => {
    fixtures = await import("../services/meetingRecoveryFixtures");
  });
  if (!fixtures) throw new Error("expected the recovery fixtures");
  const { pcmArtifact, recoveryFixture, savedTranscriptionPrompt } = fixtures;
  const fixture = await recoveryFixture(SAVED_TEXT, {
    guildId: FINISH_GUILD_ID,
    timestamp,
    context: savedTranscriptionPrompt,
    artifacts: [
      pcmArtifact("user:123", 0, Buffer.alloc(bytes, 1), [
        { startOffsetMs: 0, durationMs: SAVED_AUDIO_MS },
      ]),
    ],
    transcript: (saved) => {
      saved.entries[0].correspondence = {
        kind: "pcm",
        spans: [
          { sourceId: "user:123", sequence: 0, startByte: 0, endByte: bytes },
        ],
      };
    },
  });
  for (const [key, value] of fixture.objects)
    world.storage.objects.set(key, value);
  const saved = fixture.histories.get(FINISH_GUILD_ID)?.[0];
  if (!saved) throw new Error("expected the fixture meeting row");
  // The fixture's old-protocol recovery claim belongs to no worker here.
  const seeded: MeetingHistory = {
    ...saved,
    recovery: undefined,
    lifecycleVersion: 2,
    executionVersion: 1,
    status: "in_progress",
    ownerInstanceId: "scenario-worker-dead",
    textChannelId: FINISH_TEXT_CHANNEL_ID,
    updatedAt: options.updatedAt ?? timestamp,
  };
  await world.rows.seedHistory(seeded);
  return fixture;
}

async function expectFinishedInterrupted() {
  const row = await onlyRow(world);
  expect(row).toMatchObject({
    status: "interrupted",
    endReason: "unknown",
    duration: SAVED_AUDIO_MS / MS_PER_SECOND,
    capture: { kind: "interrupted" },
    recovery: { disposition: "done" },
  });
  expect(row.finish).toBeUndefined();
  const notice = formatMeetingCaptureNotice(row);
  expect(notice).toBeDefined();
  expect(JSON.stringify(channelMessages())).toContain(
    JSON.stringify(notice).slice(1, -1),
  );
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
}

test("scenario 3: a worker dropped mid-capture is finished from its checkpoint by another worker", async () => {
  const fixture = await meetingWithCheckpoint();
  const b = await startLoopWorker(world, "scenario-worker-b");
  const loop = b.loop({
    loadRecovery: (history, signal) =>
      b.input.loadRecoveryFinishInput(history, signal, fixture.reader),
    readCoverage: b.finisher.manifestCoverageReader(fixture.reader),
  });

  await b.run(() => loop.runFinisherScan(new AbortController().signal));
  await waitFor(
    "the adopted meeting finishes",
    () => loop.activeFinishCount() === 0,
  );

  await expectFinishedInterrupted();
});

test("scenario 4: a worker dies after the terminal status is saved, and another worker's loop posts the notes exactly once", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-4"));
  const postedBeforeDeath = await deliverAcrossADeath(1, true);

  expect(postedBeforeDeath).toBe(0);
  const row = await onlyRow(world);
  expectEveryChunkOnce(row);
  expect(channelMessages()).toHaveLength(row.notesMessageIds!.length + 1);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("scenario 5: a worker dies between two notes messages, and another worker's loop posts the rest with none repeated", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-5"));
  // The summary is post 1; the first notes chunk (post 2) lands but its id is never saved.
  const postedBeforeDeath = await deliverAcrossADeath(2, false);

  expect(postedBeforeDeath).toBe(2);
  const row = await onlyRow(world);
  expectEveryChunkOnce(row);
  expect(channelMessages()).toHaveLength(row.notesMessageIds!.length + 1);
});

test("two workers scan at once: each stranded meeting is finished once and its notes are posted once", async () => {
  const ids = Array.from(
    { length: STRANDED_MEETINGS },
    (_, index) => `scenario-meeting-pair-${index}`,
  );
  for (const id of ids) await world.rows.seedHistory(finishRow(id));
  const attempts: string[] = [];
  // Isolated imports cannot overlap, so the workers start one after the other.
  const workers = [
    await startLoopWorker(world, "scenario-worker-a"),
    await startLoopWorker(world, "scenario-worker-b"),
  ];
  const loops = workers.map((worker) =>
    worker.loop({
      finish: (claim, load, options) => {
        attempts.push(claim.meetingId);
        return worker.finish.finishMeeting(claim, load, options);
      },
      loadRecovery: async (history) =>
        spokenInput(history, "Synthetic speaker: we agreed to ship."),
    }),
  );

  const finished = async () =>
    (await world.rows.history(FINISH_GUILD_ID)).every(
      (row) => row.status === "complete" && row.finish === undefined,
    );
  await waitFor("every stranded meeting finishes", async () => {
    await Promise.all(
      loops.map((loop, index) =>
        workers[index].run(() =>
          loop.runFinisherScan(new AbortController().signal),
        ),
      ),
    );
    return loops.every((loop) => loop.activeFinishCount() === 0) && finished();
  });

  expect([...attempts].sort()).toEqual([...ids].sort());
  const rows = await world.rows.history(FINISH_GUILD_ID);
  const expected = rows.reduce(
    (count, row) => count + (row.notesMessageIds?.length ?? 0) + 1,
    0,
  );
  expect(channelMessages()).toHaveLength(expected);
  for (const row of rows) expect(row.recovery?.disposition).toBe("done");
});

test("a meeting whose worker died while recording is adopted after the grace, finished as interrupted and delivered", async () => {
  // Its last piece was saved just now while the row itself has not been
  // written for minutes, as continuous speech leaves it.
  await meetingWithCheckpoint({
    startedMsAgo: SAVED_AUDIO_MS,
    updatedAt: new Date(Date.now() - MINUTES_AGO).toISOString(),
  });
  const b = await startLoopWorker(world, "scenario-worker-b");

  await b.run(() => b.finisher.runFinisherScan(new AbortController().signal));
  // The scan starts an adoption candidate without awaiting it; it declines once it reads the manifest.
  await waitFor(
    "the declined candidate ends",
    () => b.finisher.activeFinishCount() === 0,
  );
  expect((await onlyRow(world)).status).toBe("in_progress");

  b.run(() => b.finisher.startMeetingFinisher());
  await waitFor("the meeting is delivered", delivered);
  await waitFor("the attempt ends", () => b.finisher.activeFinishCount() === 0);
  await b.finisher.stopMeetingFinisher();

  await expectFinishedInterrupted();
});

test("a meeting whose checkpoint manifest cannot be read is adopted and its failure is counted by the pipeline", async () => {
  await meetingWithCheckpoint();
  const manifestKey = (await onlyRow(world)).checkpoint?.manifest.key;
  if (!manifestKey) throw new Error("expected a checkpoint manifest");
  world.storage.objects.delete(manifestKey);
  const b = await startLoopWorker(world, "scenario-worker-b");
  const loop = b.loop({});

  await b.run(() => loop.runFinisherScan(new AbortController().signal));
  await waitFor("the attempt ends", () => loop.activeFinishCount() === 0);

  const row = await onlyRow(world);
  expect(row).toMatchObject({
    status: "processing",
    duration: 0,
    capture: { kind: "interrupted", endedAt: null },
    finish: { attempts: 1, phase: "process" },
  });
  expect(row.finish?.nextAttemptAt).toBeDefined();
  expect(row.finish?.owner).toBeUndefined();
});

test("adoption reads no audio pieces", async () => {
  await meetingWithCheckpoint();
  const b = await startLoopWorker(world, "scenario-worker-b");
  const loop = b.loop({
    loadRecovery: async (history) => spokenInput(history, SAVED_TEXT),
  });
  const reads = jest.spyOn(world.storage.objects, "get");

  await b.run(() => loop.runFinisherScan(new AbortController().signal));
  await waitFor("the attempt ends", () => loop.activeFinishCount() === 0);

  const keys = reads.mock.calls.map(([key]) => key);
  expect(keys.some((key) => key.includes("/manifests/"))).toBe(true);
  expect(keys.filter((key) => key.includes("/audio/"))).toEqual([]);
  expect(await onlyRow(world)).toMatchObject({
    status: "interrupted",
    duration: SAVED_AUDIO_MS / MS_PER_SECOND,
  });
});
