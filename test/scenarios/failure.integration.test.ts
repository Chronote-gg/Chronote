/** @jest-environment node */
import {
  MEETING_FINISH_FAILED_LOG,
  TASK_PROTECTION_FAILED_LOG,
} from "../../src/metrics";
import { LIFECYCLE as PRODUCTION_LIFECYCLE } from "../../src/services/lifecycleTiming";
import { classifyFinisherRow } from "../../src/services/meetingFinisher";
import { getProcessingRetryEligibility } from "../../src/services/processingRetryEligibility";
import { sumMeetingSecondsInWindow } from "../../src/services/meetingUsageService";
import { getLimitsForTier } from "../../src/services/subscriptionService";
import { PROCESSING_FAILED_NOTICE } from "../../src/utils/meetingProcessing";
import type { MeetingHistory } from "../../src/types/db";
import {
  embedText,
  epochSeconds,
  expectDeliveredOnce,
  gate,
  INTERRUPTED_NOTICE,
  isSummaryEdit,
  MS_PER_SECOND,
  pause,
  Scenario,
  SERVER_A,
  SPEECH_SECONDS,
  UNKNOWN_COVERAGE_NOTICE,
  UNKNOWN_END_NOTICE,
  until,
  WEEK_MS,
} from "./harness/scenario";
import { SCENARIO_ECS_AGENT_URI } from "./harness/fakeEcsAgent";
import { finishRow } from "./harness/finisher";
import { stopAddressedTo } from "./harness/scenarioExpectations";

/**
 * Scaled down so a dead worker is noticed in seconds: its registry record goes
 * stale, its abandoned capture is adopted and its finish claim lapses.
 */
const LIFECYCLE = {
  registryFreshSeconds: 2,
  abandonedGraceSeconds: 3,
  finishClaimSeconds: 2,
  finishClaimRenewMs: 500,
} as const;
const LEASE_SECONDS = 2;
/** Past the lease, so a stalled worker's lease has expired when it wakes. */
const STALL_MS = (LEASE_SECONDS + 2) * MS_PER_SECOND;
/** Adoption, recovery transcription, mixing and any retried attempt. */
const ADOPTION_WAIT_MS = 45_000;
const START_DEADLINE_MS = 2_000;
/** Longer than any hold of a recording worker's network below. */
const HELD_LEASE_SECONDS = 15;
const HOLD_WAIT_MS = 8_000;
const RARE_SCAN_MS = 60_000;
const HELD_REGISTRY_FRESH_SECONDS = 30;
/** The abandoned start's leave, row write and reply after its deadline. */
const START_DEADLINE_SLACK_MS = 3_000;
/** A lease expires within its period plus the one-second granularity of its expiry. */
const LEASE_FREE_MS = (LEASE_SECONDS + 1) * MS_PER_SECOND + 500;

let scenario: Scenario;

beforeEach(async () => {
  scenario = await Scenario.create();
});

afterEach(async () => {
  await scenario.dispose();
});

const startWorker = (release = 1, lifecycle: object = {}) =>
  scenario.startWorker({ release, lifecycle: { ...LIFECYCLE, ...lifecycle } });

function expectInterruptedNotes(row: MeetingHistory, others: string[] = []) {
  const posted = expectDeliveredOnce(scenario, row, others);
  const text = posted.map(embedText).join();
  expect(text).toContain(INTERRUPTED_NOTICE);
  // Jittered audio leaves no piece with proven timing, so coverage is unknown.
  expect(text).toContain(UNKNOWN_COVERAGE_NOTICE);
  return text;
}

const FREE_LIMIT_SECONDS =
  (getLimitsForTier("free").maxMeetingMinutesRolling ?? 0) * 60;
const EARLIER_MEETING = "synthetic-earlier-meeting";
const HOUR_MS = 3_600_000;
const WEEKLY_LIMIT_REPLY = "Weekly meeting minutes limit reached";
const ALLOWANCE_REMINDER =
  "remains in this server's rolling-week recording allowance";
/** Past the lease, so the server is free well before anyone adopts the dead meeting. */
const ADOPTION_GRACE_SECONDS = 8;

/** A meeting earlier this week that leaves the server one second short of the free plan's weekly limit. */
async function useAllButOneSecond() {
  const timestamp = new Date(Date.now() - HOUR_MS).toISOString();
  await scenario.world.rows.seedHistory(
    finishRow(EARLIER_MEETING, {
      status: "complete",
      timestamp,
      duration: FREE_LIMIT_SECONDS - 1,
      processing: { transcription: "ready", notes: "generated" },
    }),
  );
}

test("scenario 3: a worker dropped mid-capture is adopted after the grace, finished from saved audio with the recording-ended-early notice, the server is free within the lease period, and the duration counts toward the weekly limit", async () => {
  scenario.scriptReplies();
  await useAllButOneSecond();
  const grace = { abandonedGraceSeconds: ADOPTION_GRACE_SECONDS };
  const dying = await startWorker(1, grace);
  const { row: live } = await scenario.startRecording(SERVER_A, [], [dying]);
  const survivor = await startWorker(1, grace);
  const lastFrameAt = await scenario.speakAndSave(dying, live.meetingId);
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  const audio = await scenario.savedAudio(SERVER_A, live.meetingId);
  const adjustmentMs = Math.max(
    ...audio.map((piece) => piece.timing?.maxCursorAdjustmentMs ?? 0),
  );
  expect(adjustmentMs).toBeGreaterThan(0);
  const samples = scenario.sampleRow(SERVER_A, live.meetingId);

  scenario.crash(dying);
  const crashedAt = Date.now();
  // The lease is the only thing between the server and a new start, and it expires by itself.
  await scenario.leaseFree(SERVER_A, LEASE_FREE_MS);
  expect(Date.now() - crashedAt).toBeLessThanOrEqual(LEASE_FREE_MS);
  // The server is free before the dead meeting is delivered: a meeting nobody speaks in, which is not metered.
  const { row: between } = await scenario.startRecording(SERVER_A, [
    live.meetingId,
  ]);
  expect(between.ownerInstanceId).toBe(survivor.instanceId);
  expect(
    (await scenario.row(SERVER_A, live.meetingId)).recovery,
  ).toBeUndefined();
  await scenario.button(
    "end_meeting",
    await scenario.startMessageOf(SERVER_A, between.meetingId),
    SERVER_A,
  );
  const betweenDone = await scenario.delivered(SERVER_A, between.meetingId);
  // Nobody spoke, so it meters nothing: the refusal below can only come from the adopted meeting.
  expect(betweenDone.processing).toMatchObject({ transcription: "empty" });
  expect(
    sumMeetingSecondsInWindow([betweenDone], 0, Date.now() + WEEK_MS),
  ).toBe(0);

  const done = await scenario.delivered(
    SERVER_A,
    live.meetingId,
    ADOPTION_WAIT_MS,
  );
  await samples.stop();
  expect(done).toMatchObject({
    status: "interrupted",
    capture: { kind: "interrupted", endedAt: null },
    endReason: "unknown",
    captureCoverage: { kind: "unknown" },
  });
  expect(done.finish).toBeUndefined();
  expect(done.summaryMessageId).toBe(startMessage);
  // Adopted only once the grace had passed since the row's last write.
  const lastLive = samples
    .rows()
    .filter((row) => row.status === "in_progress")
    .at(-1);
  const adopted = samples.seen.find(({ row }) => row.status !== "in_progress");
  expect(
    Math.floor(Number(adopted?.atMs) / MS_PER_SECOND) -
      Math.floor(Date.parse(String(lastLive?.updatedAt)) / MS_PER_SECOND),
  ).toBeGreaterThan(ADOPTION_GRACE_SECONDS);
  // The duration runs to the last speech the dead worker received, never past its death.
  const spokenSeconds =
    (lastFrameAt - Date.parse(live.timestamp)) / MS_PER_SECOND;
  expect(Math.abs(Number(done.duration) - spokenSeconds)).toBeLessThanOrEqual(
    1 + adjustmentMs / MS_PER_SECOND,
  );
  expect(
    Date.parse(live.timestamp) + Number(done.duration) * MS_PER_SECOND,
  ).toBeLessThanOrEqual(crashedAt);
  // The meeting nobody spoke in ends with the reminder that the allowance is nearly spent.
  const reminders = scenario
    .messages(SERVER_A)
    .filter((message) => message.content.includes(ALLOWANCE_REMINDER))
    .map((message) => message.id);
  expect(reminders).toHaveLength(1);
  const text = expectInterruptedNotes(done, [
    String(betweenDone.summaryMessageId),
    ...(betweenDone.notesMessageIds ?? []),
    ...reminders,
  ]);
  expect(text).toContain(UNKNOWN_END_NOTICE);
  // It never asked to leave voice before it died.
  expect(dying.voice.departures).toEqual([]);

  // That duration is what puts the server over its weekly limit.
  const refused = await scenario.command("startmeeting", SERVER_A);
  expect(JSON.stringify(scenario.responsesTo(refused.id))).toContain(
    WEEKLY_LIMIT_REPLY,
  );
  expect(
    (await scenario.rows(SERVER_A)).filter(
      (row) => row.status === "in_progress",
    ),
  ).toEqual([]);
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 11: a worker stalls past its lease and nobody took the server, so it takes the lease again and the meeting continues", async () => {
  scenario.scriptReplies();
  // A lease lapsed past the adoption grace is lost, not retaken, so the stall stays inside it.
  const worker = await startWorker(1, {
    abandonedGraceSeconds: ADOPTION_GRACE_SECONDS,
  });
  const { row: live } = await scenario.startRecording(SERVER_A);
  const before = await scenario.world.rows.lease(SERVER_A.guildId);

  worker.network.block();
  await pause(STALL_MS);
  expect(
    (await scenario.world.rows.lease(SERVER_A.guildId))?.leaseExpiresAt,
  ).toBeLessThan(epochSeconds());
  worker.network.unblock();

  const retaken = await until(async () => {
    const lease = await scenario.world.rows.lease(SERVER_A.guildId);
    return lease && lease.leaseExpiresAt >= epochSeconds() ? lease : undefined;
  }, "lease taken again");
  expect(retaken).toMatchObject({
    meetingId: live.meetingId,
    ownerInstanceId: worker.instanceId,
    voiceOperationAttemptId: before?.voiceOperationAttemptId,
  });
  expect(await scenario.row(SERVER_A, live.meetingId)).toMatchObject({
    status: "in_progress",
  });
  await scenario.speakAndSave(worker, live.meetingId);
  await scenario.button(
    "end_meeting",
    await scenario.startMessageOf(SERVER_A, live.meetingId),
    SERVER_A,
  );
  const done = await scenario.delivered(SERVER_A, live.meetingId);
  expect(done).toMatchObject({
    status: "complete",
    endReason: "button",
    capture: { kind: "complete" },
    processing: { transcription: "ready", notes: "generated" },
  });
  expectDeliveredOnce(scenario, done);
  expect(worker.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
  ]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 11: a worker stalls past its lease while another worker starts a meeting there, so the first sends no leave, saves what it has as interrupted, and the second meeting is untouched", async () => {
  scenario.scriptReplies();
  // The production grace: the stalled worker wakes long before anyone adopts its meeting. Its own
  // finisher scans rarely, so it cannot claim its saved row before the test reads it.
  const stalled = await scenario.startWorker({
    release: 1,
    lifecycle: { finisherScanMs: RARE_SCAN_MS },
  });
  const { row: first } = await scenario.startRecording(SERVER_A, [], [stalled]);
  // A lease that outlives the hold below, so holding this worker cannot cost it its meeting.
  const other = await scenario.startWorker({
    release: 1,
    lifecycle: { leaseSeconds: HELD_LEASE_SECONDS },
  });
  await scenario.speakAndSave(stalled, first.meetingId);

  stalled.network.block();
  await pause(STALL_MS);
  const { row: second } = await scenario.startRecording(
    SERVER_A,
    [first.meetingId],
    [other],
  );
  expect(second.ownerInstanceId).toBe(other.instanceId);
  // The other worker is held off DynamoDB until the saved state is read, so its finisher cannot claim first.
  other.network.block();
  stalled.network.unblock();

  // The moment the stalled worker learns it lost the lease: saved, unclaimed, for any eligible worker.
  let saved: MeetingHistory;
  try {
    saved = await scenario.rowWith(
      SERVER_A,
      (row) =>
        row.meetingId === first.meetingId && row.status !== "in_progress",
      "first meeting saved",
      HOLD_WAIT_MS,
    );
  } finally {
    other.network.unblock();
  }
  expect(saved).toMatchObject({
    status: "processing",
    capture: { kind: "interrupted" },
    endReason: "unknown",
  });
  expect(saved.finish).toBeUndefined();
  expect(stalled.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "local_drop" },
  ]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: second.meetingId,
    ownerInstanceId: other.instanceId,
  });
  expect(other.voice.connections.has(SERVER_A.guildId)).toBe(true);
  expect(other.voice.departures).toEqual([]);
  expect(await scenario.row(SERVER_A, second.meetingId)).toMatchObject({
    status: "in_progress",
  });

  const firstDone = await scenario.delivered(SERVER_A, first.meetingId);
  expect(firstDone).toMatchObject({ status: "interrupted" });
  const secondStart = await scenario.startMessageOf(SERVER_A, second.meetingId);
  expectInterruptedNotes(firstDone, [secondStart]);

  await scenario.speakAndSave(other, second.meetingId);
  await scenario.button("end_meeting", secondStart, SERVER_A);
  const secondDone = await scenario.delivered(SERVER_A, second.meetingId);
  expect(secondDone).toMatchObject({
    status: "complete",
    capture: { kind: "complete" },
  });
  expectDeliveredOnce(scenario, [firstDone, secondDone]);
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 12: a start that never reaches receiving audio is abandoned at the deadline, the requester is told, and the server is free", async () => {
  const worker = await startWorker(1, { startDeadlineMs: START_DEADLINE_MS });
  worker.voice.stallJoins = true;
  await scenario.joinVoice(SERVER_A);

  const startedAt = Date.now();
  const start = await scenario.command("startmeeting", SERVER_A);

  const elapsed = Date.now() - startedAt;
  expect(elapsed).toBeGreaterThanOrEqual(START_DEADLINE_MS);
  expect(elapsed).toBeLessThanOrEqual(
    START_DEADLINE_MS + START_DEADLINE_SLACK_MS,
  );
  const [row] = await scenario.rows(SERVER_A);
  expect(row).toMatchObject({ status: "failed", lifecycleVersion: 2 });
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(worker.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
  ]);
  const replies = scenario
    .responsesTo(start.id)
    .filter((call) => call.method === "PATCH");
  expect(JSON.stringify(replies)).toContain("Recording could not be started");
  expect(scenario.messages(SERVER_A)).toEqual([]);

  worker.voice.stallJoins = false;
  const { row: next } = await scenario.startRecording(SERVER_A, [
    row.meetingId,
  ]);
  expect(next.status).toBe("in_progress");
  expect(scenario.alarms()).toEqual([]);
});

const SERVER_ERROR = 500;
const FORBIDDEN = 403;

test("scenario 4: a worker dropped after the terminal status is saved and before posting: the notes are posted exactly once", async () => {
  scenario.scriptReplies();
  const closing = await startWorker();
  let startMessage = "";
  let died = false;
  scenario.world.discord.rest.onRequest((call) => {
    if (died || !startMessage || !isSummaryEdit(call, startMessage)) return;
    died = true;
    scenario.crash(closing);
    throw new Error("Scenario worker died before posting");
  });
  const { row: live } = await scenario.startRecording(SERVER_A);
  startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  const other = await startWorker();
  await scenario.speak(closing, SERVER_A);
  await scenario.button("end_meeting", startMessage, SERVER_A, [closing]);
  await until(() => (died ? true : undefined), "worker died at delivery");

  const terminal = await scenario.row(SERVER_A, live.meetingId);
  expect(terminal).toMatchObject({
    status: "complete",
    finish: { phase: "deliver" },
  });
  expect(terminal.recovery).toBeUndefined();
  expect(terminal.finish?.owner).toMatch(new RegExp(`^${closing.instanceId}:`));
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();

  const done = await scenario.delivered(SERVER_A, live.meetingId);
  expect(done.status).toBe("complete");
  expectDeliveredOnce(scenario, done);
  expect(scenario.alarms()).toEqual([]);
  void other;
});

test("scenario 5: a worker dropped between two notes messages: the remaining messages are posted and none is repeated", async () => {
  scenario.scriptReplies({ longNotes: true });
  const closing = await startWorker();
  let notesPosts = 0;
  let died = false;
  scenario.world.discord.rest.onPost((call) => {
    if (
      died ||
      call.path !== `/channels/${SERVER_A.textChannelId}/messages` ||
      !JSON.stringify(call.body).includes("Meeting Notes")
    )
      return;
    notesPosts += 1;
    // The first notes message lands; the worker dies before it records the id.
    died = true;
    scenario.crash(closing);
  });
  const { row: live } = await scenario.startRecording(SERVER_A);
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  await startWorker();
  await scenario.speak(closing, SERVER_A);
  await scenario.button("end_meeting", startMessage, SERVER_A, [closing]);
  await until(() => (died ? true : undefined), "worker died between notes");
  const interrupted = await scenario.row(SERVER_A, live.meetingId);
  expect(interrupted.notesMessageIds ?? []).toEqual([]);
  expect(scenario.messages(SERVER_A)).toHaveLength(2);

  const done = await scenario.delivered(SERVER_A, live.meetingId);
  expect(done.status).toBe("complete");
  const posted = expectDeliveredOnce(scenario, done);
  // The summary, the notes message that landed before the death, and the rest.
  expect(posted.length).toBeGreaterThan(2);
  expect(notesPosts).toBe(1);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 6: Discord rejects the post temporarily, then permanently: retried, then delivery failed, the server free throughout", async () => {
  scenario.scriptReplies();
  await startWorker();
  let startMessage = "";
  let summaryEdits = 0;
  // Only the first meeting's summary edit is refused: 500 once, then 403.
  scenario.world.discord.rest.onRequest((call) => {
    if (!startMessage || !isSummaryEdit(call, startMessage)) return;
    summaryEdits += 1;
    return summaryEdits === 1 ? SERVER_ERROR : FORBIDDEN;
  });
  const { row: live } = await scenario.startRecording(SERVER_A);
  startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  await scenario.speak(scenario.recorder(live), SERVER_A);
  await scenario.button("end_meeting", startMessage, SERVER_A);
  await scenario.leaseGone();

  const retrying = await scenario.rowWith(
    SERVER_A,
    (row) =>
      row.meetingId === live.meetingId && (row.finish?.attempts ?? 0) > 0,
    "delivery retry scheduled",
  );
  expect(retrying).toMatchObject({
    status: "complete",
    finish: { attempts: 1, phase: "deliver" },
  });
  // The server is free while delivery waits: another meeting starts.
  const { row: next } = await scenario.startRecording(SERVER_A, [
    live.meetingId,
  ]);
  expect(next.status).toBe("in_progress");

  const failed = await scenario.rowWith(
    SERVER_A,
    (row) =>
      row.meetingId === live.meetingId &&
      row.delivery?.notes?.outcome === "failed" &&
      row.finish === undefined,
    "delivery marked failed",
  );
  expect(failed).toMatchObject({
    status: "complete",
    delivery: { notes: { outcome: "failed", sent: 0 } },
  });
  expect(failed.recovery).toBeUndefined();
  expect(summaryEdits).toBe(2);
  // Nothing was posted for the first meeting: the channel holds both start messages only.
  expect(scenario.messages(SERVER_A).map((message) => message.id)).toEqual([
    startMessage,
    await scenario.startMessageOf(SERVER_A, next.meetingId),
  ]);
  // A permanent error raises no alarm.
  expect(scenario.alarms()).toEqual([]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: next.meetingId,
  });
});

/** Each attempt may retry the call; this outlasts every attempt. */
const MODEL_FAILURES = 1_000;
/** One retry per backoff entry; the failure after the last is final. */
const FINISH_RETRIES = PRODUCTION_LIFECYCLE.finishBackoffSeconds.length;

test.each([
  ["notes", "text"],
  ["transcription", "transcription"],
] as const)(
  "scenario 7: %s keeps failing: retried on the finish schedule, then failed with one notice and an alarm, retryable from the portal, the server free",
  async (_label, kind) => {
    scenario.scriptReplies();
    await startWorker();
    await startWorker();
    const { row: live } = await scenario.startRecording(SERVER_A);
    const startMessage = await scenario.startMessageOf(
      SERVER_A,
      live.meetingId,
    );
    await scenario.speak(scenario.recorder(live), SERVER_A);
    scenario.world.openai.failNext(kind, MODEL_FAILURES);
    const samples = scenario.sampleRow(SERVER_A, live.meetingId);
    await scenario.button("end_meeting", startMessage, SERVER_A);
    await scenario.leaseGone();

    let failed: MeetingHistory;
    try {
      failed = await scenario.rowWith(
        SERVER_A,
        (row) =>
          row.meetingId === live.meetingId &&
          row.status === "failed" &&
          row.finish === undefined,
        "meeting failed after its retries",
      );
    } finally {
      await samples.stop();
    }
    // Each failed attempt is counted on the row, one per backoff entry, and the next one fails it.
    const attempts = [
      ...new Set(samples.rows().flatMap((row) => row.finish?.attempts ?? [])),
    ].filter((count) => count > 0);
    expect(attempts).toEqual(
      Array.from({ length: FINISH_RETRIES }, (_, index) => index + 1),
    );
    // Retries stay in processing until the last one fails, which saves failed before it drops the claim.
    for (const row of samples.rows())
      if ((row.finish?.attempts ?? 0) > 0) {
        expect(row.finish).toMatchObject({ phase: "process" });
        expect(["processing", "failed"]).toContain(row.status);
      }
    expect(failed.notes).toBeUndefined();
    expect(Object.values(failed.processing ?? {})).toContain("failed");
    expect(getProcessingRetryEligibility(failed)).toMatchObject({
      eligible: true,
    });
    const messages = scenario.messages(SERVER_A);
    expect(messages.map((message) => message.id)).toEqual([startMessage]);
    expect(messages[0].content).toBe(PROCESSING_FAILED_NOTICE);
    expect(scenario.alarms()).toEqual([MEETING_FINISH_FAILED_LOG]);
    expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  },
);

/**
 * An abandoned meeting that failed silently: interrupted with no notes, no
 * request but reads since `requests`, the channel unchanged from `before` and
 * holding only the start message, the server free and no alarm.
 */
async function expectFailedSilently(
  failed: MeetingHistory,
  seen: { requests: number; before: string; startMessage: string },
) {
  expect(failed.capture).toMatchObject({ kind: "interrupted" });
  expect(failed.notes).toBeUndefined();
  // Nothing is posted or edited: the recording message stays as it was.
  expect(
    scenario.world.discord.rest
      .requests()
      .slice(seen.requests)
      .filter((call) => call.method !== "GET"),
  ).toEqual([]);
  expect(JSON.stringify(scenario.messages(SERVER_A))).toBe(seen.before);
  expect(scenario.messages(SERVER_A).map((message) => message.id)).toEqual([
    seen.startMessage,
  ]);
  await scenario.leaseFree(SERVER_A);
  expect(scenario.alarms()).toEqual([]);
}

test("scenario 13: a start that dies before saving any audio ends silently", async () => {
  const dying = await startWorker();
  const { row: live } = await scenario.startRecording(SERVER_A, [], [dying]);
  await startWorker();
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  const before = JSON.stringify(scenario.messages(SERVER_A));
  const requests = scenario.world.discord.rest.requests().length;

  scenario.crash(dying);
  const failed = await scenario.rowWith(
    SERVER_A,
    (row) => row.meetingId === live.meetingId && row.status === "failed",
    "abandoned start failed",
    ADOPTION_WAIT_MS,
  );
  await until(
    async () =>
      (await scenario.row(SERVER_A, live.meetingId)).finish === undefined
        ? true
        : undefined,
    "claim released",
  );

  await expectFailedSilently(failed, { requests, before, startMessage });
});

/** The production seal period: a worker that dies inside it has saved no piece. */
const PRODUCTION_SEGMENT_MS = PRODUCTION_LIFECYCLE.checkpointSegmentMs;

test("a worker that dies while its first speech is still inside the seal period, so no piece was saved, ends the meeting failed with nothing posted and the server free", async () => {
  scenario.scriptReplies();
  const dying = await startWorker(1, {
    checkpointSegmentMs: PRODUCTION_SEGMENT_MS,
  });
  const { row: live } = await scenario.startRecording(SERVER_A, [], [dying]);
  await startWorker();
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  const spokeAt = Date.now();
  await scenario.speak(dying, SERVER_A);
  expect(await scenario.savedAudio(SERVER_A, live.meetingId)).toEqual([]);
  const before = JSON.stringify(scenario.messages(SERVER_A));
  const requests = scenario.world.discord.rest.requests().length;

  scenario.crash(dying);
  expect(Date.now() - spokeAt).toBeLessThan(PRODUCTION_SEGMENT_MS);
  const failed = await scenario.rowWith(
    SERVER_A,
    (row) =>
      row.meetingId === live.meetingId &&
      row.status === "failed" &&
      row.finish === undefined,
    "abandoned meeting failed",
    ADOPTION_WAIT_MS,
  );

  expect(await scenario.savedAudio(SERVER_A, live.meetingId)).toEqual([]);
  await expectFailedSilently(failed, { requests, before, startMessage });
});

/** The flush bound, scaled down so a close that cannot save its last pieces ends in seconds. */
const CLOSE_FLUSH_MS = 2_000;
const REGISTRY_SETTLE_MS = 1_500;
const CHANNEL_EMPTY_NOTICE =
  "Meeting ending due to nobody being left in the voice channel.";

/** The close notice an auto-recording posts when its channel empties. */
const channelEmptyNotice = () =>
  scenario
    .messages(SERVER_A)
    .filter((message) => message.content === CHANNEL_EMPTY_NOTICE)
    .map((message) => message.id);

/** Leaves voice while storage refuses every upload, so the close cannot save its last piece. */
async function closeDuringStorageOutage() {
  const rejectedBefore = scenario.world.storage.rejectedUploads;
  scenario.world.storage.uploadsFailing = true;
  try {
    await scenario.leaveVoice(SERVER_A);
    await scenario.leaseGone(SERVER_A);
  } finally {
    scenario.world.storage.uploadsFailing = false;
  }
  expect(scenario.world.storage.rejectedUploads).toBeGreaterThan(
    rejectedBefore,
  );
}

test("from an incident: an auto-recording whose end hits a storage failure during the final save still frees the server, records the capture end with its completion policy and decision, and a different worker finishes it without the row ever waiting on nothing", async () => {
  scenario.scriptReplies();
  await scenario.enableAutoRecord();
  // Registry records stay fresh while the finisher is held below, so the closing worker stays draining.
  const fresh = { registryFreshSeconds: HELD_REGISTRY_FRESH_SECONDS };
  const closing = await startWorker(1, {
    ...fresh,
    closeFlushMs: CLOSE_FLUSH_MS,
  });
  await scenario.joinVoice(SERVER_A);
  const live = await scenario.rowWith(
    SERVER_A,
    (row) => row.status === "in_progress",
    "auto-recording started",
  );
  expect(live).toMatchObject({
    isAutoRecording: true,
    ownerInstanceId: closing.instanceId,
  });
  // A newer worker makes the closing one a draining worker, so the finish is another worker's.
  const finisher = await startWorker(2, fresh);
  await pause(REGISTRY_SETTLE_MS);
  await scenario.speakAndSave(closing, live.meetingId);

  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  let done: MeetingHistory;
  let closed: MeetingHistory;
  try {
    // The finisher is held off DynamoDB until the closed row is read, so it cannot claim first.
    finisher.network.block();
    try {
      await closeDuringStorageOutage();
      closed = await scenario.row(SERVER_A, live.meetingId);
    } finally {
      finisher.network.unblock();
    }
    done = await scenario.delivered(SERVER_A, live.meetingId);
  } finally {
    await samples.stop();
  }

  // The close could not evaluate the policy without its last piece, says so, and leaves the row unclaimed.
  expect(closed).toMatchObject({
    status: "processing",
    endReason: "channel_empty",
    completionPolicy: { isAutoRecording: true, decision: "undecided" },
  });
  expect(closed.finish).toBeUndefined();
  expect(closed.duration).toBeGreaterThanOrEqual(SPEECH_SECONDS);
  // The finisher must be able to take every processing state it can observe.
  for (const { atMs, row } of samples.seen) {
    const now = Math.floor(atMs / MS_PER_SECOND);
    const claimHeld = (row.finish?.expiresAt ?? 0) >= now;
    const retryDue = (row.finish?.nextAttemptAt ?? 0) > now;
    if (row.status === "processing" && !claimHeld && !retryDue)
      expect(classifyFinisherRow(row, undefined, now)).toBe("claim");
  }
  const owners = samples.owners();
  expect(owners).not.toEqual([]);
  for (const owner of owners)
    expect(owner.startsWith(`${finisher.instanceId}:`)).toBe(true);
  // The flush failed and the closing worker took no claim, so the finish from the checkpoint
  // lacks the unsaved tail and the capture is recorded as interrupted.
  expect(done).toMatchObject({
    status: "interrupted",
    capture: { kind: "interrupted" },
    completionPolicy: { decision: "proceed" },
  });
  // Besides the result, only the notice that the channel emptied, which the close posted.
  expectInterruptedNotes(done, channelEmptyNotice());
  expect(scenario.alarms()).toEqual([]);
});

test("a storage failure at close on the only eligible worker, as production runs today: the server is freed and the same worker finishes the meeting under the claim its close wrote, and delivers it", async () => {
  scenario.scriptReplies();
  await scenario.enableAutoRecord();
  const only = await startWorker(1, { closeFlushMs: CLOSE_FLUSH_MS });
  await scenario.joinVoice(SERVER_A);
  const live = await scenario.rowWith(
    SERVER_A,
    (row) => row.status === "in_progress",
    "auto-recording started",
  );
  await scenario.speakAndSave(only, live.meetingId);

  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  let done: MeetingHistory;
  try {
    await closeDuringStorageOutage();
    done = await scenario.delivered(SERVER_A, live.meetingId);
  } finally {
    await samples.stop();
  }

  expect(done).toMatchObject({
    status: "complete",
    endReason: "channel_empty",
    processing: { transcription: "ready", notes: "generated" },
  });
  // One claim, the close's own, carried it to delivery: the local finish, with no retry or second claim.
  const owners = [...new Set(samples.owners())];
  expect(owners).toHaveLength(1);
  expect(owners[0].startsWith(`${only.instanceId}:`)).toBe(true);
  for (const row of samples.rows()) expect(row.finish?.attempts ?? 0).toBe(0);
  expectDeliveredOnce(scenario, done, channelEmptyNotice());
  expect(scenario.alarms()).toEqual([]);
});

test("from an incident: a worker dies before close, so the row has no completion decision; the finisher adopts it, the recovery loader resolves the policy, and the result is delivered", async () => {
  scenario.scriptReplies();
  await scenario.enableAutoRecord();
  const dying = await startWorker();
  await scenario.joinVoice(SERVER_A);
  const live = await scenario.rowWith(
    SERVER_A,
    (row) => row.status === "in_progress",
    "auto-recording started",
  );
  expect(live.ownerInstanceId).toBe(dying.instanceId);
  await startWorker();
  await scenario.speakAndSave(dying, live.meetingId);

  scenario.crash(dying);
  const undecided = await scenario.row(SERVER_A, live.meetingId);
  expect(undecided.completionPolicy).toBeUndefined();

  const done = await scenario.delivered(
    SERVER_A,
    live.meetingId,
    ADOPTION_WAIT_MS,
  );
  // The recovery loader resolves an interrupted capture as proceed whatever its saved policy says,
  // short of a recorded cancel: it was not cancelled, and nothing invents a decision on the row.
  expect(done).toMatchObject({
    status: "interrupted",
    endReason: "unknown",
    capture: { kind: "interrupted" },
    recovery: { disposition: "done", outcome: "completed" },
    processing: { notes: "generated" },
  });
  expect(done.cancellationReason).toBeUndefined();
  expect(done.completionPolicy).toBeUndefined();
  expectInterruptedNotes(done);
  expect(scenario.alarms()).toEqual([]);
});

test("a meeting's worker dies while a portal stop command addressed to it is pending: an eligible worker answers it as ended", async () => {
  const dying = await startWorker();
  const { row: live } = await scenario.startRecording(SERVER_A, [], [dying]);
  const survivor = await startWorker();
  scenario.crash(dying);
  const answered = await stopAddressedTo(
    scenario,
    SERVER_A,
    live.meetingId,
    dying.instanceId,
  );
  expect(answered).toMatchObject({
    queueStatus: "completed",
    claimedByInstanceId: survivor.instanceId,
    result: {
      status: "ended",
      serverId: SERVER_A.guildId,
      meetingId: live.meetingId,
    },
  });
  await scenario.leaseFree(SERVER_A);
  expect(scenario.alarms()).toEqual([]);
});

/** A free server's meeting cap; the lease cap is this plus the grace, scaled below to seconds. */
const FREE_MEETING_MS = getLimitsForTier("free").maxMeetingDurationMs ?? 0;
const LEASE_CAP_AFTER_MS = 5_000;
const PROTECTION_RETRY_MS = 300;
const CAP_RETRY_MARGIN_SECONDS = 3;
const SECONDS_PER_MINUTE = 60;

/** Starts a worker that talks to the fake ECS agent, with its lease cap `capAfterMs` after the start. */
const protectedWorker = (capAfterMs: number) =>
  scenario.startWorker({
    release: 1,
    env: { ECS_AGENT_URI: SCENARIO_ECS_AGENT_URI, PORT: "0" },
    lifecycle: {
      ...LIFECYCLE,
      leaseCapGraceMs: capAfterMs - FREE_MEETING_MS,
      protectionRetryMs: PROTECTION_RETRY_MS,
    },
  });

const leaseCapOf = (live: MeetingHistory, capAfterMs: number) =>
  Math.floor((Date.parse(live.timestamp) + capAfterMs) / MS_PER_SECOND);

const enablesSoFar = () =>
  scenario.world.ecsAgent.calls.filter(
    (call) => call.body.ProtectionEnabled === true,
  );

const protectionCleared = () =>
  until(
    () =>
      scenario.world.ecsAgent.calls.some(
        (call) => call.body.ProtectionEnabled === false,
      )
        ? true
        : undefined,
    "protection cleared",
  );

test("scenario 15: a worker's protection is never extended once its lease has reached the cap, even while the process still counts the capture as live", async () => {
  scenario.scriptReplies();
  // Every request is refused, so the worker keeps retrying for as long as it may.
  const worker = await protectedWorker(LEASE_CAP_AFTER_MS);
  // The capped close waits on its nickname restore, so the capture stays in memory past the cap.
  const nickname = gate();
  nickname.close();
  let holdRestore = false;
  scenario.world.discord.rest.onRequest(async (call) => {
    if (
      holdRestore &&
      call.method === "PATCH" &&
      call.path.startsWith(`/guilds/${SERVER_A.guildId}/members/`)
    )
      await nickname.wait();
  });
  const { row: live } = await scenario.startRecording(SERVER_A);
  holdRestore = true;
  const cap = leaseCapOf(live, LEASE_CAP_AFTER_MS);
  await scenario.speak(worker, SERVER_A);

  const counted = await until(async () => {
    const self = (await scenario.world.rows.registry()).workers.find(
      (item) => item.instanceId === worker.instanceId,
    );
    return self && self.heartbeatAt > cap && self.captures > 0
      ? self
      : undefined;
  }, "capture still counted after the cap");
  expect(counted.captures).toBe(1);
  // Long enough for several protection retries while the capture is counted.
  await pause(3 * PROTECTION_RETRY_MS);
  nickname.open();
  const closed = await scenario.rowWith(
    SERVER_A,
    (row) => row.meetingId === live.meetingId && row.status !== "in_progress",
    "capped capture closed",
  );
  expect(closed.endReason).toBe("timeout");
  await scenario.leaseGone(SERVER_A);

  // Retried up to the cap, so a missing cap check would show as a request after it; none comes.
  const asked = enablesSoFar().map((call) =>
    Math.floor(call.atMs / MS_PER_SECOND),
  );
  expect(asked.length).toBeGreaterThan(1);
  // Retries every 300 ms reach the last seconds before the cap; the margin absorbs an event-loop stall.
  expect(Math.max(...asked)).toBeGreaterThanOrEqual(
    cap - CAP_RETRY_MARGIN_SECONDS,
  );
  for (const at of asked) expect(at).toBeLessThanOrEqual(cap);
  await protectionCleared();
  // Only the refused protection calls this scenario is about raise an alarm.
  expect(scenario.alarms()).toHaveLength(asked.length);
  for (const line of scenario.alarms())
    expect(line.startsWith(TASK_PROTECTION_FAILED_LOG)).toBe(true);
});

/** Far enough off that the meeting ends well before its lease cap. */
const DISTANT_CAP_AFTER_MS = 120_000;

test("a protection request refused once and then granted asks for cover to the lease cap plus its margin, and the registry advertises the expiry granted", async () => {
  scenario.scriptReplies();
  scenario.world.ecsAgent.refusedEnables = 1;
  const worker = await protectedWorker(DISTANT_CAP_AFTER_MS);
  const { row: live } = await scenario.startRecording(SERVER_A);
  const cap = leaseCapOf(live, DISTANT_CAP_AFTER_MS);
  await scenario.speak(worker, SERVER_A);

  const granted = await until(
    () => enablesSoFar().find((call) => call.expiresAtMs !== undefined),
    "protection granted",
  );
  const advertised = await until(async () => {
    const self = (await scenario.world.rows.registry()).workers.find(
      (item) => item.instanceId === worker.instanceId,
    );
    return self?.protectedUntil;
  }, "protection advertised");
  expect(advertised).toBe(
    Math.floor(Number(granted.expiresAtMs) / MS_PER_SECOND),
  );
  const enables = enablesSoFar();
  expect(enables.length).toBeGreaterThanOrEqual(2);
  for (const call of enables)
    expect(call.body.ExpiresInMinutes).toBe(
      Math.ceil(
        (cap +
          PRODUCTION_LIFECYCLE.protectionPastCapSeconds -
          Math.floor(call.atMs / MS_PER_SECOND)) /
          SECONDS_PER_MINUTE,
      ),
    );

  await scenario.button(
    "end_meeting",
    await scenario.startMessageOf(SERVER_A, live.meetingId),
    SERVER_A,
  );
  await scenario.delivered(SERVER_A, live.meetingId);
  await protectionCleared();
  // Only the one refused request raises an alarm.
  expect(scenario.alarms()).toHaveLength(1);
  expect(scenario.alarms()[0].startsWith(TASK_PROTECTION_FAILED_LOG)).toBe(
    true,
  );
});
