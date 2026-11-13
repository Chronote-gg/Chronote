import { MEETING_FINISH_FAILED_LOG } from "../../src/metrics";
import { PROCESSING_FAILED_NOTICE } from "../../src/utils/meetingProcessing";
import {
  FINISH_GUILD_ID,
  FINISH_START,
  finishRow,
  onlyRow,
  spokenInput,
  startFinishWorker,
} from "./harness/finisher";
import {
  finishChannelMessages,
  useFinishWorld,
} from "./harness/finishScenario";
import type { World } from "./harness/world";

const FINISH_ATTEMPTS = 4;
/** Each attempt can retry the notes call; this outlasts all of them. */
const NOTES_FAILURES = 100;

let world: World;
useFinishWorld((created) => {
  world = created;
});

const alarms = () =>
  jest
    .mocked(console.error)
    .mock.calls.filter(([line]) => line === MEETING_FINISH_FAILED_LOG).length;

test("scenario 7: notes keep failing, so the meeting is retried and then fails with one notice", async () => {
  const worker = await startFinishWorker(world, "scenario-worker-a");
  await world.rows.seedHistory(finishRow("scenario-meeting-7"));
  world.openai.failNext("text", NOTES_FAILURES);

  for (let attempt = 1; attempt <= FINISH_ATTEMPTS; attempt++) {
    const row = await onlyRow(world);
    const claim = await worker.claim(row);
    if (!claim) throw new Error(`attempt ${attempt} could not claim`);
    await worker.run(() =>
      worker.finish.finishMeeting(claim, async () =>
        spokenInput(claim.history, "Synthetic speaker: we agreed to ship."),
      ),
    );
    const after = await onlyRow(world);
    if (attempt < FINISH_ATTEMPTS)
      expect(after).toMatchObject({
        status: "processing",
        finish: { attempts: attempt, phase: "process" },
      });
  }

  const textCalls = world.openai.calls.filter((call) => call.kind === "text");
  expect(textCalls.length).toBeGreaterThanOrEqual(FINISH_ATTEMPTS);
  const row = await onlyRow(world);
  expect(row.status).toBe("failed");
  expect(row.finish).toBeUndefined();
  expect(row.notes).toBeUndefined();
  const posted = finishChannelMessages(world);
  expect(posted.map((message) => message.content)).toEqual([
    PROCESSING_FAILED_NOTICE,
  ]);
  expect(alarms()).toBe(1);
  expect(await world.rows.lease(FINISH_GUILD_ID)).toBeUndefined();
});

test("scenario 13: a start that saved no audio ends failed without a post", async () => {
  const worker = await startFinishWorker(world, "scenario-worker-a");
  const seeded = finishRow("scenario-meeting-13", {
    status: "starting",
    duration: 0,
    capture: undefined,
  });
  await world.rows.seedHistory(seeded);
  const now = Math.floor(Date.now() / 1000);
  const claim = await worker.adopt(
    seeded,
    "scenario-worker-a",
    {
      capture: {
        kind: "interrupted",
        startedAt: FINISH_START,
        detectedAt: new Date().toISOString(),
        endedAt: null,
      },
      endReason: "unknown",
      duration: 0,
    },
    now,
  );
  if (!claim) throw new Error("expected to adopt the abandoned start");
  await worker.run(() =>
    worker.finish.finishMeeting(claim, (signal) =>
      worker.input.loadRecoveryFinishInput(claim.history, signal),
    ),
  );

  const row = await onlyRow(world);
  expect(row.status).toBe("failed");
  expect(row.finish).toBeUndefined();
  expect(world.discord.rest.requests()).toEqual([]);
  expect(alarms()).toBe(0);
});
