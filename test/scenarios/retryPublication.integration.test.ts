/** @jest-environment node */
import { MEETING_FINISH_FAILED_LOG } from "../../src/metrics";
import { embedText, Scenario, SERVER_A } from "./harness/scenario";
import {
  failEveryAttempt,
  saveRetriedNotes,
} from "./harness/processingFailure";

/** Scaled down as in the failure scenarios, so the finish retries run in seconds. */
const LIFECYCLE = {
  registryFreshSeconds: 2,
  abandonedGraceSeconds: 3,
  finishClaimSeconds: 2,
  finishClaimRenewMs: 500,
} as const;

let scenario: Scenario;

beforeEach(async () => {
  scenario = await Scenario.create();
});

afterEach(async () => {
  await scenario.dispose();
});

test("a processing retry of a failed meeting turns its failure notice into the summary card and posts the notes", async () => {
  const { failed, startMessage } = await failEveryAttempt(
    scenario,
    () => scenario.startWorker({ release: 1, lifecycle: LIFECYCLE }),
    "text",
  );
  const notes = "Synthetic notes the retry produced";
  expect(await saveRetriedNotes(scenario, failed, notes)).toMatchObject({
    kind: "saved",
  });
  const published = await scenario.rowWith(
    SERVER_A,
    (row) =>
      row.meetingId === failed.meetingId &&
      row.recovery?.disposition === "done" &&
      row.finish === undefined,
    "retried meeting published",
  );
  expect(published).toMatchObject({
    status: "complete",
    summaryMessageId: startMessage,
    updateDelivery: { policy: { kind: "active" } },
    processingRetry: { status: "succeeded" },
  });
  const [card, ...posted] = scenario.messages(SERVER_A);
  expect(card.id).toBe(startMessage);
  expect(card.content).toBe("");
  expect(card.embeds).toHaveLength(1);
  expect(posted.map((message) => message.id)).toEqual(
    published.notesMessageIds,
  );
  expect(posted.map(embedText).join()).toContain(notes);
  expect(scenario.alarms()).toEqual([MEETING_FINISH_FAILED_LOG]);
});
