/** @jest-environment node */
import { rm } from "node:fs/promises";
import { getMeetingTempDir } from "../../src/services/tempFileService";
import type { MeetingHistory } from "../../src/types/db";
import {
  addFinishChannels,
  FINISH_GUILD_ID,
  FINISH_SPEAKER,
  FINISH_TEXT_CHANNEL_ID,
  FINISH_VOICE_CHANNEL_ID,
} from "./harness/finisher";
import { spokenPcm } from "./harness/scenario";
import {
  createWorld,
  SCENARIO_LIFECYCLE_OVERRIDES,
  type ScenarioWorker,
  type World,
} from "./harness/world";

const POLL_MS = 50;
const SNIPPET_TRANSCRIPTIONS = 2;
const WAIT_MS = 30_000;

async function until<T>(
  read: () => Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

let world: World;
const workers: ScenarioWorker[] = [];

beforeEach(async () => {
  world = await createWorld();
  addFinishChannels(world);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  jest.spyOn(console, "debug").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.sigterm();
  for (const row of await world.rows.history(FINISH_GUILD_ID))
    await rm(getMeetingTempDir(row), { recursive: true, force: true });
  jest.restoreAllMocks();

  await world.dispose();
});

async function startWorker(release: number, instanceId: string) {
  const worker = await world.startWorker({ release, instanceId });
  workers.push(worker);
  return worker;
}

const eligible = (instanceId: string) =>
  until(async () => {
    const view = await world.rows.registry();
    const self = view.workers.find((item) => item.instanceId === instanceId);
    return view.cutover && self?.ready ? self : undefined;
  }, `${instanceId} eligible`);

const rowWith = (
  predicate: (row: MeetingHistory) => boolean,
  description: string,
) =>
  until(async () => {
    const rows = await world.rows.history(FINISH_GUILD_ID);
    return rows.find(predicate);
  }, description);

function endButtonMessage(): string {
  const message = [...world.discord.rest.messages.values()].find(
    (candidate) =>
      candidate.channel_id === FINISH_TEXT_CHANNEL_ID &&
      JSON.stringify(candidate.components).includes("end_meeting"),
  );
  if (!message) throw new Error("No recording message with an end button");
  return message.id;
}

const MODEL_REPLIES = 20;
/**
 * Valid as every text reply a finish asks for (final pass, notes, summary), so
 * scenarios do not depend on how many finishes run or in which order.
 */
function scriptReplies() {
  world.openai.script(
    "text",
    ...Array.from({ length: MODEL_REPLIES }, () =>
      JSON.stringify({
        edits: [],
        summarySentence: "The team agreed to ship on Friday.",
        summaryLabel: "Ship Friday",
      }),
    ),
  );
}

const postedNotes = () =>
  [...world.discord.rest.messages.values()].filter(
    (message) =>
      message.channel_id === FINISH_TEXT_CHANNEL_ID &&
      JSON.stringify(message.embeds).includes("Ship Friday"),
  );

async function startRecording(worker: ScenarioWorker) {
  await worker.joinVoice(
    FINISH_GUILD_ID,
    FINISH_VOICE_CHANNEL_ID,
    FINISH_SPEAKER,
  );
  await worker.command("startmeeting", {}, FINISH_SPEAKER);
  return rowWith((row) => row.status === "in_progress", "recording started");
}

test("a worker starts, becomes eligible, records a meeting through the fakes, closes it, and its local finish saves and posts the notes", async () => {
  scriptReplies();
  const worker = await startWorker(1, "scenario-worker-a");
  await eligible("scenario-worker-a");

  const recording = await startRecording(worker);
  await worker.speak(FINISH_GUILD_ID, FINISH_SPEAKER.id, spokenPcm());
  await worker.button("end_meeting", endButtonMessage(), FINISH_SPEAKER);

  const finished = await rowWith(
    (row) =>
      row.meetingId === recording.meetingId &&
      row.status === "complete" &&
      row.recovery?.disposition === "done",
    "meeting finished and delivered",
  );
  expect(finished).toMatchObject({
    lifecycleVersion: 2,
    endReason: "button",
    capture: { kind: "complete" },
    recovery: { disposition: "done", stage: "delivery" },
  });
  expect(finished.notes).toBeTruthy();
  expect(finished.notesMessageIds?.length).toBeGreaterThan(0);
  expect(postedNotes().length).toBeGreaterThan(0);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("a second worker on a higher release becomes eligible and the first stops taking new meetings while its live capture continues", async () => {
  scriptReplies();
  const first = await startWorker(1, "scenario-worker-a");
  await eligible("scenario-worker-a");
  const recording = await startRecording(first);

  const second = await startWorker(2, "scenario-worker-b");
  await eligible("scenario-worker-b");
  // The first worker sees the newer release on its next heartbeat.
  await new Promise((resolve) =>
    setTimeout(resolve, 2 * SCENARIO_LIFECYCLE_OVERRIDES.registryHeartbeatMs),
  );

  await first.speak(FINISH_GUILD_ID, FINISH_SPEAKER.id, spokenPcm());
  expect(await world.rows.lease(FINISH_GUILD_ID)).toMatchObject({
    meetingId: recording.meetingId,
    ownerInstanceId: "scenario-worker-a",
  });
  // A control for its own capture still reaches the draining worker.
  await first.button("end_meeting", endButtonMessage(), FINISH_SPEAKER);
  await rowWith(
    (row) =>
      row.meetingId === recording.meetingId && row.status !== "in_progress",
    "first recording closed",
  );
  await until(
    async () => ((await world.rows.lease(FINISH_GUILD_ID)) ? undefined : true),
    "lease released",
  );

  const ignored = await first.command("startmeeting", {}, FINISH_SPEAKER);
  expect(ignored.responses).toEqual([]);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();

  await second.joinVoice(
    FINISH_GUILD_ID,
    FINISH_VOICE_CHANNEL_ID,
    FINISH_SPEAKER,
  );
  await second.command("startmeeting", {}, FINISH_SPEAKER);
  const next = await rowWith(
    (row) =>
      row.meetingId !== recording.meetingId && row.status === "in_progress",
    "second recording started",
  );
  expect(next.ownerInstanceId).toBe("scenario-worker-b");
});

test("SIGTERM during a capture saves it as interrupted and another worker finishes it", async () => {
  scriptReplies();
  const first = await startWorker(1, "scenario-worker-a");
  const second = await startWorker(1, "scenario-worker-b");
  await eligible("scenario-worker-a");
  await eligible("scenario-worker-b");
  const recording = await startRecording(first);
  const savedBefore = recording.checkpoint?.revision ?? 0;
  await first.speak(FINISH_GUILD_ID, FINISH_SPEAKER.id, spokenPcm());
  // The speech must be transcribed and checkpointed for another worker to recover it.
  // A low-confidence snippet is transcribed twice (prompted and unprompted), so wait for both.
  await until(
    async () =>
      world.openai.calls.filter((call) => call.kind === "transcription")
        .length >= SNIPPET_TRANSCRIPTIONS
        ? true
        : undefined,
    "speech transcribed",
  );
  await rowWith(
    (row) =>
      row.meetingId === recording.meetingId &&
      (row.checkpoint?.revision ?? 0) > savedBefore,
    "transcription checkpointed",
  );

  await first.sigterm();

  const interrupted = (await world.rows.history(FINISH_GUILD_ID)).find(
    (row) => row.meetingId === recording.meetingId,
  );
  expect(interrupted).toMatchObject({
    capture: { kind: "interrupted" },
    endReason: "unknown",
  });
  // A shutting-down worker writes no finish claim and counts no attempt; the other worker may already hold one.
  expect(interrupted?.finish?.owner ?? "").not.toMatch(/^scenario-worker-a:/);
  expect(interrupted?.finish?.attempts ?? 0).toBe(0);
  const registry = await world.rows.registry();
  expect(
    registry.workers.find((item) => item.instanceId === "scenario-worker-a"),
  ).toMatchObject({ ready: false });

  const finished = await rowWith(
    (row) =>
      row.meetingId === recording.meetingId &&
      row.recovery?.disposition === "done",
    "interrupted meeting finished elsewhere",
  );
  // An interrupted capture's terminal status is interrupted, with its notes delivered.
  expect(finished).toMatchObject({
    status: "interrupted",
    capture: { kind: "interrupted" },
    recovery: { stage: "delivery", outcome: "completed" },
  });
  expect(finished.notes).toBeTruthy();
  expect(postedNotes().length).toBeGreaterThan(0);
  void second;
});
