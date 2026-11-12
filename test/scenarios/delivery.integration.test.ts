import { MEETING_DELIVERY_FAILED_LOG } from "../../src/metrics";
import { renderMeetingDelivery } from "../../src/services/meetingDelivery";
import type { MeetingHistory } from "../../src/types/db";
import { NOTES } from "../services/meetingDelivery.fixture";
import {
  addFinishChannels,
  FINISH_GUILD_ID,
  FINISH_TEXT_CHANNEL_ID,
  finishRow,
  onlyRow,
  spokenInput,
  startFinishWorker,
} from "./harness/finisher";
import { createWorld, type World } from "./harness/world";

const FORBIDDEN = 403;
const SERVER_ERROR = 500;
const PERMANENT_FAILURES = 10;

let world: World;

beforeEach(async () => {
  world = await createWorld();
  addFinishChannels(world);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  await world.dispose();
});

/** A meeting whose terminal status and notes were saved before delivery began. */
function savedMeeting(
  meetingId: string,
  overrides: Partial<MeetingHistory> = {},
) {
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
    ...overrides,
  });
}

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

/** Kills `worker` while it answers its `count`th POST; `refuse` also fails that POST. */
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

async function finishWith(
  worker: Awaited<ReturnType<typeof startFinishWorker>>,
) {
  const row = await onlyRow(world);
  const claim = await worker.claim(row);
  if (!claim) throw new Error(`${worker.seams.instanceId} could not claim`);
  return worker.run(() =>
    worker.finish.finishMeeting(claim, async () =>
      spokenInput(claim.history, "Synthetic transcript."),
    ),
  );
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
  expect(new Set(row.notesMessageIds).size).toBe(chunks.length);
  expect(row.recovery?.disposition).toBe("done");
  expect(row.finish).toBeUndefined();
}

test("scenario 4: a worker dies after the terminal status is saved, and a second run posts the notes exactly once", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-4"));
  const a = await startFinishWorker(world, "scenario-worker-a");
  const died = killOnPost(() => a.seams.kill(), 1, true);
  await expect(finishWith(a)).rejects.toThrow("was killed");
  expect(died()).toBe(true);
  expect(channelMessages()).toHaveLength(0);

  const b = await startFinishWorker(world, "scenario-worker-b");
  await finishWith(b);
  const row = await onlyRow(world);
  expectEveryChunkOnce(row);
  expect(channelMessages()).toHaveLength(row.notesMessageIds!.length + 1);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("scenario 5: a worker dies between two notes messages, and the rest are posted with none repeated", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-5"));
  const a = await startFinishWorker(world, "scenario-worker-a");
  // The summary is post 1; the first notes chunk (post 2) lands but its id is never saved.
  const died = killOnPost(() => a.seams.kill(), 2, false);
  await expect(finishWith(a)).rejects.toThrow("was killed");
  expect(died()).toBe(true);
  expect(channelMessages()).toHaveLength(2);
  const interrupted = await onlyRow(world);
  expect(interrupted.notesMessageIds).toBeUndefined();

  const b = await startFinishWorker(world, "scenario-worker-b");
  await finishWith(b);
  const row = await onlyRow(world);
  expectEveryChunkOnce(row);
  expect(row.summaryMessageId).toBe(interrupted.summaryMessageId);
  expect(channelMessages()).toHaveLength(row.notesMessageIds!.length + 1);
});

test("scenario 6: Discord rejects the post temporarily, then permanently: retried, then delivery failed", async () => {
  const start = await fetch(
    `https://discord.com/api/v10/channels/${FINISH_TEXT_CHANNEL_ID}/messages`,
    { method: "POST", body: JSON.stringify({ content: "Recording started" }) },
  ).then((reply) => reply.json());
  await world.rows.seedHistory(
    savedMeeting("scenario-meeting-6", { startMessageId: start.id }),
  );
  const a = await startFinishWorker(world, "scenario-worker-a");

  world.discord.rest.failNext(SERVER_ERROR, 1);
  await finishWith(a);
  const retrying = await onlyRow(world);
  expect(retrying).toMatchObject({
    status: "complete",
    finish: { attempts: 1, phase: "deliver" },
  });
  expect(retrying.finish?.deliverSince).toBeDefined();
  expect(retrying.finish?.owner).toBeUndefined();
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();

  world.discord.rest.failNext(FORBIDDEN, PERMANENT_FAILURES);
  await finishWith(a);
  const row = await onlyRow(world);
  expect(row).toMatchObject({
    status: "complete",
    delivery: { notes: { outcome: "failed", sent: 0 } },
  });
  expect(row.finish).toBeUndefined();
  expect(row.recovery).toBeUndefined();
  expect(channelMessages()).toHaveLength(1);
  expect(
    jest
      .mocked(console.error)
      .mock.calls.filter(([line]) => line === MEETING_DELIVERY_FAILED_LOG),
  ).toHaveLength(0);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});
