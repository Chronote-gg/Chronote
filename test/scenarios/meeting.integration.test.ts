/** @jest-environment node */
import { sumMeetingSecondsInWindow } from "../../src/services/meetingUsageService";
import { EMPTY_RECORDING_NOTICE } from "../../src/utils/meetingProcessing";
import {
  embedText,
  epochSeconds,
  expectDeliveredOnce,
  gate,
  MS_PER_SECOND,
  pause,
  Scenario,
  SERVER_A,
  SPEECH_SECONDS,
  SUMMARY_LABEL,
  until,
  WEEK_MS,
} from "./harness/scenario";

const SETTLE_MS = 1_000;
const ENDED_RECORDING_REPLY = "The recording has ended. Notes will follow.";
/** A duration is counted in whole seconds from the start to the close. */
const DURATION_SLACK_SECONDS = 1;

let scenario: Scenario;

beforeEach(async () => {
  scenario = await Scenario.create();
});

afterEach(async () => {
  await scenario.dispose();
});

test("scenario 1: start, speak, end: notes posted once, lease gone, a second start in the same server succeeds", async () => {
  scenario.scriptReplies();
  const worker = await scenario.startWorker({ release: 1 });
  const first = await scenario.startRecording(SERVER_A);
  await scenario.speak(worker, SERVER_A);

  const startMessage = await scenario.startMessageOf(
    SERVER_A,
    first.row.meetingId,
  );
  const pressedAt = Date.now();
  await scenario.button("end_meeting", startMessage, SERVER_A);
  const finished = await scenario.delivered(SERVER_A, first.row.meetingId);

  expect(finished).toMatchObject({
    status: "complete",
    lifecycleVersion: 2,
    endReason: "button",
    capture: { kind: "complete" },
    processing: { transcription: "ready", notes: "generated" },
  });
  expect(finished.finish).toBeUndefined();
  // The meeting lasted the speech and the moments around it, and no longer than until the press.
  expect(finished.duration).toBeGreaterThanOrEqual(SPEECH_SECONDS);
  expect(finished.duration).toBeLessThanOrEqual(
    (pressedAt - Date.parse(finished.timestamp)) / MS_PER_SECOND +
      DURATION_SLACK_SECONDS,
  );
  const [summary] = expectDeliveredOnce(scenario, finished);
  expect(embedText(summary)).toContain(SUMMARY_LABEL);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();

  const second = await scenario.startRecording(SERVER_A, [first.row.meetingId]);
  expect(second.row.meetingId).not.toBe(first.row.meetingId);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: second.row.meetingId,
  });
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 2: a second meeting starts while the first is still being processed, and controls on each reach the right meeting", async () => {
  scenario.scriptReplies();
  const notesHeld = gate();
  notesHeld.close();
  scenario.world.openai.onCall(async (call) => {
    if (call.kind === "text") await notesHeld.wait();
  });
  const worker = await scenario.startWorker({ release: 1 });
  const first = await scenario.startRecording(SERVER_A);
  await scenario.speak(worker, SERVER_A);
  const firstMessage = await scenario.startMessageOf(
    SERVER_A,
    first.row.meetingId,
  );
  await scenario.button("end_meeting", firstMessage, SERVER_A);
  await scenario.leaseGone();

  const second = await scenario.startRecording(SERVER_A, [first.row.meetingId]);
  expect(await scenario.row(SERVER_A, first.row.meetingId)).toMatchObject({
    status: "processing",
  });
  // The first meeting's End button, pressed again while the second records.
  const stale = await scenario.button("end_meeting", firstMessage, SERVER_A);
  expect(JSON.stringify(scenario.responsesTo(stale.id))).toContain(
    "This meeting control is no longer active.",
  );
  expect(await scenario.row(SERVER_A, second.row.meetingId)).toMatchObject({
    status: "in_progress",
  });
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: second.row.meetingId,
  });

  notesHeld.open();
  const firstDone = await scenario.delivered(SERVER_A, first.row.meetingId);
  await scenario.speak(worker, SERVER_A);
  const secondMessage = await scenario.startMessageOf(
    SERVER_A,
    second.row.meetingId,
  );
  expect(secondMessage).not.toBe(firstMessage);
  await scenario.button("end_meeting", secondMessage, SERVER_A);
  const secondDone = await scenario.delivered(SERVER_A, second.row.meetingId);

  for (const done of [firstDone, secondDone])
    expect(done).toMatchObject({
      status: "complete",
      endReason: "button",
      capture: { kind: "complete" },
      processing: { transcription: "ready", notes: "generated" },
    });
  expectDeliveredOnce(scenario, [firstDone, secondDone]);
  await scenario.leaseGone();
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 8: two workers receive the same start: exactly one meeting, one start message, one response", async () => {
  const a = await scenario.startWorker({ release: 1 });
  const b = await scenario.startWorker({ release: 1 });

  const { row, interaction } = await scenario.startRecording(SERVER_A);
  // Both workers have answered by now; give a slower loser time to write anything it would.
  await pause(SETTLE_MS);

  const rows = await scenario.rows(SERVER_A);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    meetingId: row.meetingId,
    status: "in_progress",
  });
  const callbacks = scenario
    .responsesTo(interaction.id)
    .filter((call) => call.path.endsWith("/callback"));
  expect(callbacks).toHaveLength(1);
  // Nothing but the one recording message, with its End button.
  const messages = scenario.messages(SERVER_A);
  expect(messages).toHaveLength(1);
  expect(JSON.stringify(messages[0].components)).toContain("end_meeting");
  const joined = [a, b].filter((worker) =>
    worker.voice.connections.has(SERVER_A.guildId),
  );
  expect(joined).toHaveLength(1);
  expect(joined[0].instanceId).toBe(row.ownerInstanceId);
  expect([...a.voice.departures, ...b.voice.departures]).toEqual([]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: row.meetingId,
    ownerInstanceId: row.ownerInstanceId,
  });
  expect(scenario.alarms()).toEqual([]);
});

test("two eligible workers see the same auto-record voice join at the same instant: exactly one recording and one start message", async () => {
  await scenario.enableAutoRecord(SERVER_A);
  const a = await scenario.startWorker({ release: 1 });
  const b = await scenario.startWorker({ release: 1 });

  await scenario.joinVoice(SERVER_A);
  const row = await scenario.rowWith(
    SERVER_A,
    (candidate) => candidate.status === "in_progress",
    "auto-recording started",
  );
  await pause(SETTLE_MS);

  expect(await scenario.rows(SERVER_A)).toEqual([
    expect.objectContaining({
      meetingId: row.meetingId,
      isAutoRecording: true,
      status: "in_progress",
    }),
  ]);
  const messages = scenario.messages(SERVER_A);
  expect(messages.map((message) => message.id)).toEqual([
    await scenario.startMessageOf(SERVER_A, row.meetingId),
  ]);
  const joined = [a, b].filter((worker) =>
    worker.voice.connections.has(SERVER_A.guildId),
  );
  expect(joined.map((worker) => worker.instanceId)).toEqual([
    row.ownerInstanceId,
  ]);
  expect([...a.voice.departures, ...b.voice.departures]).toEqual([]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: row.meetingId,
    ownerInstanceId: row.ownerInstanceId,
  });
  expect(scenario.alarms()).toEqual([]);
});

test("an End press in a server where no worker is recording gets exactly one reply that the recording has ended, from one of two eligible workers", async () => {
  scenario.scriptReplies();
  await scenario.startWorker({ release: 1 });
  await scenario.startWorker({ release: 1 });
  const { row } = await scenario.startRecording(SERVER_A);
  await scenario.speak(scenario.recorder(row), SERVER_A);
  const startMessage = await scenario.startMessageOf(SERVER_A, row.meetingId);
  await scenario.button("end_meeting", startMessage, SERVER_A);
  const done = await scenario.delivered(SERVER_A, row.meetingId);
  const requests = scenario.world.discord.rest.requests().length;

  const late = await scenario.button("end_meeting", startMessage, SERVER_A);
  await pause(SETTLE_MS);

  const responses = scenario.responsesTo(late.id);
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({
    method: "POST",
    body: { data: { content: ENDED_RECORDING_REPLY } },
  });
  // Nothing else: no new meeting, no message, no edit.
  expect(
    scenario.world.discord.rest
      .requests()
      .slice(requests)
      .filter((call) => call.method !== "GET"),
  ).toEqual(responses);
  expectDeliveredOnce(scenario, done);
  expect(await scenario.rows(SERVER_A)).toEqual([done]);
  expect(scenario.alarms()).toEqual([]);
});

test("an End press while a dead worker's lease is still unexpired gets no reply from anyone, by design, since only the lease holder may answer it; once the lease expires the press gets exactly one reply that the recording has ended", async () => {
  const dying = await scenario.startWorker({ release: 1 });
  const { row } = await scenario.startRecording(SERVER_A, [], [dying]);
  await scenario.startWorker({ release: 1 });
  await scenario.startWorker({ release: 1 });
  const startMessage = await scenario.startMessageOf(SERVER_A, row.meetingId);

  scenario.crash(dying);
  const during = await scenario.button("end_meeting", startMessage, SERVER_A);
  // The press was handled while the dead worker's lease still stood.
  expect(
    (await scenario.world.rows.lease(SERVER_A.guildId))?.leaseExpiresAt,
  ).toBeGreaterThanOrEqual(epochSeconds());
  expect(scenario.responsesTo(during.id)).toEqual([]);
  expect(
    await scenario.world.rows.get("InteractionReceiptTable", {
      interactionId: during.id,
    }),
  ).toBeUndefined();

  await scenario.leaseFree(SERVER_A);
  const after = await scenario.button("end_meeting", startMessage, SERVER_A);
  const responses = scenario.responsesTo(after.id);
  expect(responses).toHaveLength(1);
  expect(responses[0]).toMatchObject({
    method: "POST",
    body: { data: { content: ENDED_RECORDING_REPLY } },
  });
  expect(scenario.alarms()).toEqual([]);
});

test("a manual meeting where nobody speaks ends complete with the no-speech notice and is not metered", async () => {
  await scenario.startWorker({ release: 1 });
  const { row } = await scenario.startRecording(SERVER_A);
  await pause(SETTLE_MS);
  const startMessage = await scenario.startMessageOf(SERVER_A, row.meetingId);
  await scenario.button("end_meeting", startMessage, SERVER_A);
  const done = await scenario.delivered(SERVER_A, row.meetingId);

  expect(done).toMatchObject({
    status: "complete",
    endReason: "button",
    capture: { kind: "complete" },
    processing: { transcription: "empty", notes: "skipped" },
  });
  expect(done.notes).toBeUndefined();
  expect(done.finish).toBeUndefined();
  // The no-speech notice goes through the same summary card and notes message as notes would.
  const posted = expectDeliveredOnce(scenario, done);
  expect(posted[0].id).toBe(startMessage);
  expect(posted.map(embedText).join()).toContain(EMPTY_RECORDING_NOTICE);
  expect(sumMeetingSecondsInWindow([done], 0, Date.now() + WEEK_MS)).toBe(0);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(scenario.alarms()).toEqual([]);
});

test("an auto-recording in a channel that empties before anyone speaks ends cancelled with the cancelled message", async () => {
  await scenario.enableAutoRecord(SERVER_A);
  scenario.world.openai.script(
    "text",
    JSON.stringify({ cancel: true, reason: "Nobody spoke." }),
  );
  await scenario.startWorker({ release: 1 });
  await scenario.joinVoice(SERVER_A);
  const row = await scenario.rowWith(
    SERVER_A,
    (candidate) => candidate.status === "in_progress",
    "auto-recording started",
  );
  expect(row.isAutoRecording).toBe(true);
  const startMessage = await scenario.startMessageOf(SERVER_A, row.meetingId);

  await scenario.leaveVoice(SERVER_A);
  const done = await scenario.delivered(SERVER_A, row.meetingId);

  expect(done).toMatchObject({
    status: "cancelled",
    endReason: "auto_cancelled",
    completionPolicy: { decision: "cancel" },
  });
  expect(done.notes).toBeUndefined();
  expect(done.finish).toBeUndefined();
  const messages = scenario.messages(SERVER_A);
  expect(messages.map((message) => message.id)).toEqual([startMessage]);
  expect(embedText(messages[0])).toContain("cancelled");
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(scenario.alarms()).toEqual([]);
});

test("the portal's control queue: a stop command reaches the recording worker and the recording message shows processing", async () => {
  scenario.scriptReplies();
  const notesHeld = gate();
  notesHeld.close();
  scenario.world.openai.onCall(async (call) => {
    if (call.kind === "text") await notesHeld.wait();
  });
  await scenario.startWorker({ release: 1 });
  await scenario.startWorker({ release: 1 });
  const { row } = await scenario.startRecording(SERVER_A);
  const recorder = scenario.recorder(row);
  await scenario.speak(recorder, SERVER_A);
  const startMessage = await scenario.startMessageOf(SERVER_A, row.meetingId);

  const requestId = await scenario.queueControl(
    "stop_meeting",
    SERVER_A,
    {
      serverId: SERVER_A.guildId,
      meetingId: row.meetingId,
    },
    row.ownerInstanceId,
  );

  const command = await until(async () => {
    const item = await scenario.controlCommand(requestId);
    return item?.queueStatus === "pending" ? undefined : item;
  }, "control command answered");
  expect(command).toMatchObject({
    queueStatus: "completed",
    claimedByInstanceId: recorder.instanceId,
    result: {
      status: "ended",
      serverId: SERVER_A.guildId,
      meetingId: row.meetingId,
    },
  });
  await scenario.leaseGone();
  const processing = await until(() => {
    const message = scenario.world.discord.rest.messages.get(startMessage);
    return message && embedText(message).includes("(processing)")
      ? message
      : undefined;
  }, "recording message shows processing");
  expect(processing.components).toEqual([]);

  notesHeld.open();
  const done = await scenario.delivered(SERVER_A, row.meetingId);
  expect(done).toMatchObject({
    status: "complete",
    endReason: "mcp",
    capture: { kind: "complete" },
  });
  expectDeliveredOnce(scenario, done);
  expect(scenario.alarms()).toEqual([]);
});
