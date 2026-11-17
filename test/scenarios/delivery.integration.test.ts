import { MEETING_DELIVERY_FAILED_LOG } from "../../src/metrics";
import {
  FINISH_GUILD_ID,
  FINISH_TEXT_CHANNEL_ID,
  onlyRow,
  spokenInput,
  startFinishWorker,
} from "./harness/finisher";
import {
  expectEveryChunkOnce,
  finishChannelMessages,
  killOnPost,
  savedMeeting,
  useFinishWorld,
} from "./harness/finishScenario";
import type { World } from "./harness/world";

const FORBIDDEN = 403;
const SERVER_ERROR = 500;
const PERMANENT_FAILURES = 10;

let world: World;
useFinishWorld((created) => {
  world = created;
});

const channelMessages = () => finishChannelMessages(world);

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

test("scenario 4: a worker dies after the terminal status is saved, and a second run posts the notes exactly once", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-4"));
  const a = await startFinishWorker(world, "scenario-worker-a");
  const died = killOnPost(world, () => a.seams.kill(), 1, true);
  await expect(finishWith(a)).rejects.toThrow("was killed");
  expect(died()).toBe(true);
  expect(channelMessages()).toHaveLength(0);

  const b = await startFinishWorker(world, "scenario-worker-b");
  await finishWith(b);
  const row = await onlyRow(world);
  expectEveryChunkOnce(world, row);
  expect(channelMessages()).toHaveLength(row.notesMessageIds!.length + 1);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("scenario 5: a worker dies between two notes messages, and the rest are posted with none repeated", async () => {
  await world.rows.seedHistory(savedMeeting("scenario-meeting-5"));
  const a = await startFinishWorker(world, "scenario-worker-a");
  // The summary is post 1; the first notes chunk (post 2) lands but its id is never saved.
  const died = killOnPost(world, () => a.seams.kill(), 2, false);
  await expect(finishWith(a)).rejects.toThrow("was killed");
  expect(died()).toBe(true);
  expect(channelMessages()).toHaveLength(2);
  const interrupted = await onlyRow(world);
  expect(interrupted.notesMessageIds).toBeUndefined();

  const b = await startFinishWorker(world, "scenario-worker-b");
  await finishWith(b);
  const row = await onlyRow(world);
  expectEveryChunkOnce(world, row);
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
