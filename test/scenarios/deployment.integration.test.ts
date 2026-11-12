/** @jest-environment node */
import type { MeetingHistory } from "../../src/types/db";
import { sumMeetingSecondsInWindow } from "../../src/services/meetingUsageService";
import { EMPTY_RECORDING_NOTICE } from "../../src/utils/meetingProcessing";
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
  SERVER_B,
  SPEECH_SECONDS,
  UNKNOWN_COVERAGE_NOTICE,
  until,
  type ScenarioServer,
} from "./harness/scenario";
import { SCENARIO_ECS_AGENT_URI } from "./harness/fakeEcsAgent";
import { finishRow } from "./harness/finisher";
import {
  SCENARIO_LIFECYCLE_OVERRIDES,
  type ScenarioWorker,
} from "./harness/world";

/** A registry record older than this is a worker that may be gone; scaled down so a death is seen quickly. */
const LIFECYCLE = { registryFreshSeconds: 2 } as const;
/** Long enough for every worker to have read the registry since the last change. */
const REGISTRY_SETTLE_MS = 3 * SCENARIO_LIFECYCLE_OVERRIDES.registryHeartbeatMs;
const MODAL_RESPONSE = 9;
const SETTLE_MS = 1_000;
const WEEK_MS = 7 * 24 * 60 * 60 * MS_PER_SECOND;
/** The summary card a meeting with no usable speech carries. */
const NO_SUMMARY = "Summary unavailable.";

let scenario: Scenario;

beforeEach(async () => {
  scenario = await Scenario.create();
});

afterEach(async () => {
  await scenario.dispose();
});

const startWorker = (release: number, lifecycle: object = {}) =>
  scenario.startWorker({ release, lifecycle: { ...LIFECYCLE, ...lifecycle } });

const callbacksTo = (id: string) =>
  scenario.responsesTo(id).filter((call) => call.path.endsWith("/callback"));

/** Every finish claim on the row went to `worker`, and there was one. */
function expectFinishedBy(owners: string[], worker: ScenarioWorker) {
  expect(owners).not.toEqual([]);
  for (const owner of owners)
    expect(owner.startsWith(`${worker.instanceId}:`)).toBe(true);
}

test("scenario 9: a newer worker becomes ready: the older one stops taking starts, keeps its live meeting to the end, and its controls still reach it; the newer worker finishes it; when the newer worker dies the older one takes starts again", async () => {
  scenario.scriptReplies();
  const older = await startWorker(1);
  const { row: live } = await scenario.startRecording(SERVER_A);
  expect(live.ownerInstanceId).toBe(older.instanceId);
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);

  const newer = await startWorker(2);
  await pause(REGISTRY_SETTLE_MS);

  // The older worker no longer answers a start at all, even one only it receives.
  await scenario.joinVoice(SERVER_B);
  const ignored = await scenario.command("startmeeting", SERVER_B, {}, [older]);
  expect(ignored.responses).toEqual([]);
  expect(await scenario.rows(SERVER_B)).toEqual([]);
  // A start in another server during the drain is taken by the newer worker.
  const { row: elsewhere } = await scenario.startRecording(SERVER_B);
  expect(elsewhere.ownerInstanceId).toBe(newer.instanceId);

  // The draining worker's live meeting still records and answers its own controls.
  await scenario.speak(older, SERVER_A);
  const editTags = await scenario.button("edit_tags", startMessage, SERVER_A);
  const callbacks = callbacksTo(editTags.id);
  expect(callbacks).toHaveLength(1);
  expect(callbacks[0].body).toMatchObject({ type: MODAL_RESPONSE });
  const tagged = await scenario.modal(
    "edit_tags_modal",
    { tags_input: "drain" },
    SERVER_A,
  );
  expect(JSON.stringify(scenario.responsesTo(tagged.id))).toContain(
    "Tags updated: drain",
  );
  const ttsStop = await scenario.command("tts", SERVER_A, {
    subcommand: "stop",
  });
  expect(JSON.stringify(scenario.responsesTo(ttsStop.id))).toContain(
    "Stopped current playback",
  );
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toMatchObject({
    meetingId: live.meetingId,
    ownerInstanceId: older.instanceId,
  });

  // The stop button reaching only the newer worker: another worker's lease is live, so it stays silent.
  const toNewer = await scenario.button("end_meeting", startMessage, SERVER_A, [
    newer,
  ]);
  await pause(SETTLE_MS);
  expect(scenario.responsesTo(toNewer.id)).toEqual([]);
  expect(
    await scenario.world.rows.get("InteractionReceiptTable", {
      interactionId: toNewer.id,
    }),
  ).toBeUndefined();
  expect(await scenario.row(SERVER_A, live.meetingId)).toMatchObject({
    status: "in_progress",
  });

  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  const toOlder = await scenario.button("end_meeting", startMessage, SERVER_A, [
    older,
  ]);
  expect(callbacksTo(toOlder.id)).toHaveLength(1);
  await scenario.leaseGone(SERVER_A);
  let done: MeetingHistory;
  try {
    done = await scenario.delivered(SERVER_A, live.meetingId);
  } finally {
    await samples.stop();
  }
  // A draining worker writes no finish claim: an eligible worker finishes it.
  expectFinishedBy(samples.owners(), newer);
  expect(done).toMatchObject({
    status: "complete",
    endReason: "button",
    capture: { kind: "complete" },
    tags: ["drain"],
    // The speech during the drain was captured.
    processing: { transcription: "ready", notes: "generated" },
  });
  const posted = expectDeliveredOnce(scenario, done);
  expect(posted.map(embedText).join()).not.toContain(INTERRUPTED_NOTICE);
  expect(older.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
  ]);

  // The newer worker dies; once its heartbeat is stale the older one takes starts again.
  scenario.crash(newer);
  await pause(
    LIFECYCLE.registryFreshSeconds * MS_PER_SECOND + REGISTRY_SETTLE_MS,
  );
  const { row: again } = await scenario.startRecording(SERVER_A, [
    live.meetingId,
  ]);
  expect(again.ownerInstanceId).toBe(older.instanceId);
  expect(scenario.alarms()).toEqual([]);
});

test("a portal stop addressed to a draining worker that holds the recording reaches it and ends the meeting", async () => {
  scenario.scriptReplies();
  const older = await startWorker(1);
  const { row: live } = await scenario.startRecording(SERVER_A);
  await startWorker(2);
  await pause(REGISTRY_SETTLE_MS);
  await scenario.speak(older, SERVER_A);

  const requestId = await scenario.queueControl(
    "stop_meeting",
    SERVER_A,
    { serverId: SERVER_A.guildId, meetingId: live.meetingId },
    older.instanceId,
  );
  const answered = await until(async () => {
    const command = await scenario.controlCommand(requestId);
    return command?.queueStatus === "pending" ? undefined : command;
  }, "stop command answered");
  expect(answered).toMatchObject({
    queueStatus: "completed",
    claimedByInstanceId: older.instanceId,
    result: {
      status: "ended",
      serverId: SERVER_A.guildId,
      meetingId: live.meetingId,
    },
  });
  await scenario.leaseGone(SERVER_A);
  const done = await scenario.delivered(SERVER_A, live.meetingId);
  expect(done).toMatchObject({
    status: "complete",
    endReason: "mcp",
    capture: { kind: "complete" },
    processing: { transcription: "ready", notes: "generated" },
  });
  expectDeliveredOnce(scenario, done);
  expect(older.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
  ]);
  expect(scenario.alarms()).toEqual([]);
});

test("a deployment while the older worker holds two live recordings in two servers: both continue to their end and both are finished and delivered once", async () => {
  scenario.scriptReplies();
  const older = await startWorker(1);
  const { row: liveA } = await scenario.startRecording(SERVER_A);
  const { row: liveB } = await scenario.startRecording(SERVER_B);
  expect([liveA.ownerInstanceId, liveB.ownerInstanceId]).toEqual([
    older.instanceId,
    older.instanceId,
  ]);
  const newer = await startWorker(2);
  await pause(REGISTRY_SETTLE_MS);

  const lives: [ScenarioServer, MeetingHistory][] = [
    [SERVER_A, liveA],
    [SERVER_B, liveB],
  ];
  await Promise.all(lives.map(([server]) => scenario.speak(older, server)));
  const samples = lives.map(([server, live]) =>
    scenario.sampleRow(server, live.meetingId),
  );
  for (const [server, live] of lives) {
    expect(await scenario.world.rows.lease(server.guildId)).toMatchObject({
      meetingId: live.meetingId,
      ownerInstanceId: older.instanceId,
    });
    await scenario.button(
      "end_meeting",
      await scenario.startMessageOf(server, live.meetingId),
      server,
    );
  }
  const done: MeetingHistory[] = [];
  try {
    for (const [server, live] of lives)
      done.push(await scenario.delivered(server, live.meetingId));
  } finally {
    await Promise.all(samples.map((sample) => sample.stop()));
  }

  for (const [index, row] of done.entries()) {
    expect(row).toMatchObject({
      status: "complete",
      endReason: "button",
      capture: { kind: "complete" },
      processing: { transcription: "ready", notes: "generated" },
    });
    expectFinishedBy(samples[index].owners(), newer);
    expectDeliveredOnce(scenario, row);
  }
  expect(older.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
    { guildId: SERVER_B.guildId, kind: "leave" },
  ]);
  expect(scenario.alarms()).toEqual([]);
});

test("a silent recording that ends on a draining worker gets the no-speech card from the worker that finishes it", async () => {
  const older = await startWorker(1);
  const { row: live } = await scenario.startRecording(SERVER_A);
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  const newer = await startWorker(2);
  await pause(REGISTRY_SETTLE_MS);

  // A silent finish makes no model call, so its delivery is held until the claim has been sampled.
  const held = gate();
  held.close();
  scenario.world.discord.rest.onRequest(async (call) => {
    if (
      call.method === "PATCH" &&
      call.path.endsWith(`/messages/${startMessage}`) &&
      JSON.stringify(call.body).includes(NO_SUMMARY)
    )
      await held.wait();
  });
  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  await scenario.button("end_meeting", startMessage, SERVER_A, [older]);
  let done: MeetingHistory;
  try {
    await until(async () => samples.owners()[0], "finish claimed");
    held.open();
    done = await scenario.delivered(SERVER_A, live.meetingId);
  } finally {
    held.open();
    await samples.stop();
  }
  // The draining worker wrote no claim, so the eligible worker finished it from the checkpoint.
  expectFinishedBy(samples.owners(), newer);
  expect(done).toMatchObject({
    status: "complete",
    endReason: "button",
    capture: { kind: "complete" },
    processing: { transcription: "empty", notes: "skipped" },
  });
  expect(done.notes).toBeUndefined();
  const posted = expectDeliveredOnce(scenario, done);
  expect(posted[0].id).toBe(startMessage);
  expect(posted.map(embedText).join()).toContain(EMPTY_RECORDING_NOTICE);
  expect(sumMeetingSecondsInWindow([done], 0, Date.now() + WEEK_MS)).toBe(0);
  expect(scenario.alarms()).toEqual([]);
});

test("scenario 10: SIGTERM during capture: flushed, left voice, lease released, saved as interrupted, finished by the other worker with the recording-ended-early notice and the saved audio", async () => {
  scenario.scriptReplies();
  const stopping = await startWorker(1);
  const { row: live } = await scenario.startRecording(SERVER_A, [], [stopping]);
  const other = await startWorker(1);
  await scenario.speakAndSave(stopping, live.meetingId);
  const revisionBefore =
    (await scenario.row(SERVER_A, live.meetingId)).checkpoint?.revision ?? 0;

  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  // The other worker is held off DynamoDB until the saved state is read, so its finisher cannot claim first.
  other.network.block();
  await scenario.sigterm(stopping);
  const saved = await scenario.row(SERVER_A, live.meetingId);
  other.network.unblock();

  expect(stopping.voice.departures).toEqual([
    { guildId: SERVER_A.guildId, kind: "leave" },
  ]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  // Saved as interrupted and left unclaimed for an eligible worker.
  expect(saved).toMatchObject({
    status: "processing",
    capture: { kind: "interrupted" },
    endReason: "unknown",
  });
  expect(saved.finish).toBeUndefined();
  expect(saved.duration).toBeGreaterThanOrEqual(SPEECH_SECONDS);
  // The flush published the final context as one more checkpoint revision.
  expect(saved.checkpoint?.revision).toBeGreaterThan(revisionBefore);
  const registry = await scenario.world.rows.registry();
  expect(
    registry.workers.find((item) => item.instanceId === stopping.instanceId),
  ).toMatchObject({ ready: false });

  let done: MeetingHistory;
  try {
    done = await scenario.delivered(SERVER_A, live.meetingId);
  } finally {
    await samples.stop();
  }
  expectFinishedBy(samples.owners(), other);
  expect(done).toMatchObject({
    status: "interrupted",
    capture: { kind: "interrupted" },
    endReason: "unknown",
    captureCoverage: { kind: "unknown" },
  });
  expect(done.finish).toBeUndefined();
  const text = expectDeliveredOnce(scenario, done).map(embedText).join();
  expect(text).toContain(INTERRUPTED_NOTICE);
  expect(text).toContain(UNKNOWN_COVERAGE_NOTICE);
  expect(scenario.alarms()).toEqual([]);
});

/** Scaled down from five seconds so a shutdown hands an aborted finish back quickly. */
const FINISH_ABORT_WAIT_MS = 500;

test.each(["generating notes", "posting after the terminal status is saved"])(
  "a finish attempt aborted by SIGTERM while %s is resumed by another worker: notes posted exactly once and no attempt counted for the shutdown",
  async (stage) => {
    scenario.scriptReplies();
    const held = gate();
    held.close();
    let holding = true;
    let reached = false;
    let startMessage = "";
    if (stage === "generating notes")
      scenario.world.openai.onCall(async (call) => {
        if (!holding || call.kind !== "text") return;
        reached = true;
        await held.wait();
      });
    else
      scenario.world.discord.rest.onRequest(async (call) => {
        if (!holding || !startMessage || !isSummaryEdit(call, startMessage))
          return;
        reached = true;
        await held.wait();
      });
    const first = await startWorker(1, {
      finishAbortWaitMs: FINISH_ABORT_WAIT_MS,
    });
    const { row: live } = await scenario.startRecording(SERVER_A, [], [first]);
    const second = await startWorker(1);
    startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
    await scenario.speak(first, SERVER_A);
    const samples = scenario.sampleRow(SERVER_A, live.meetingId);
    await scenario.button("end_meeting", startMessage, SERVER_A);
    await until(() => (reached ? true : undefined), `finish ${stage}`);
    expect(
      (await scenario.row(SERVER_A, live.meetingId)).finish?.owner,
    ).toMatch(new RegExp(`^${first.instanceId}:`));

    await scenario.sigterm(first);
    holding = false;
    held.open();
    let done: MeetingHistory;
    try {
      done = await scenario.delivered(SERVER_A, live.meetingId);
    } finally {
      await samples.stop();
    }

    const owners = samples.owners();
    expect(owners[0].startsWith(`${first.instanceId}:`)).toBe(true);
    expect(owners.at(-1)?.startsWith(`${second.instanceId}:`)).toBe(true);
    for (const row of samples.rows()) expect(row.finish?.attempts ?? 0).toBe(0);
    expect(done).toMatchObject({
      status: "complete",
      processing: { transcription: "ready", notes: "generated" },
    });
    expectDeliveredOnce(scenario, done);
    expect(scenario.alarms()).toEqual([]);
  },
);

/** The old protocol's heartbeat goes stale after this; scaled down from two minutes, past one control poll. */
const LEGACY_STALE_SECONDS = 6;
/** The bot polls its control queue this often (`meetingControlWorkerService`). */
const CONTROL_POLL_MS = 2_000;
const STANDBY_HOLD_MS = CONTROL_POLL_MS + SETTLE_MS;
const STANDBY = {
  ...LIFECYCLE,
  legacyHeartbeatStaleSeconds: LEGACY_STALE_SECONDS,
};
const CUTOVER_KEY = { pk: "WORKERS", sk: "CUTOVER" };
const CUTOVER_WAIT_MS = (LEGACY_STALE_SECONDS + 2) * MS_PER_SECOND;

test("scenario 14: while an old-protocol runtime is fresh the new worker is ready but takes nothing; once it is stale the worker writes the cutover once and becomes eligible, and stays eligible when the old record turns fresh again", async () => {
  await scenario.world.seedLegacyRuntime(epochSeconds());
  // A meeting an earlier worker left processing: a running finisher would claim it at once.
  const waiting = finishRow("synthetic-standby-processing", {
    timestamp: new Date().toISOString(),
  });
  await scenario.world.rows.seedHistory(waiting);
  scenario.world.ecsAgent.refusedEnables = 0;
  const first = await scenario.startWorker({
    release: 1,
    env: { ECS_AGENT_URI: SCENARIO_ECS_AGENT_URI, PORT: "0" },
    lifecycle: STANDBY,
  });
  // Fresh again from here, so standby lasts the hold below whatever the start-up took.
  await scenario.world.seedLegacyRuntime(epochSeconds());
  const registered = await scenario.world.rows.registry();
  expect(registered.cutover).toBe(false);
  expect(
    registered.workers.find((item) => item.instanceId === first.instanceId),
  ).toMatchObject({ ready: true });

  // Standby: no start, no interaction answered, no control command polled, no finish, no protection.
  const status = await scenario.queueControl(
    "get_live_meeting_status",
    SERVER_A,
    { serverId: SERVER_A.guildId },
  );
  await scenario.joinVoice(SERVER_A);
  const refused = await scenario.command("startmeeting", SERVER_A);
  expect(refused.responses).toEqual([]);
  const help = await scenario.command("tts", SERVER_A, { subcommand: "stop" });
  expect(help.responses).toEqual([]);
  await pause(STANDBY_HOLD_MS);
  expect(await scenario.rows(SERVER_A)).toEqual([waiting]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(await scenario.controlCommand(status)).toMatchObject({
    queueStatus: "pending",
  });
  expect(
    await scenario.world.rows.get("DeploymentControlTable", CUTOVER_KEY),
  ).toBeUndefined();
  expect(scenario.world.discord.rest.posts()).toEqual([]);
  expect(scenario.world.ecsAgent.calls).toEqual([]);

  // The old heartbeat goes stale: one cutover, and the worker takes meetings.
  const cutover = await until(
    () => scenario.world.rows.get("DeploymentControlTable", CUTOVER_KEY),
    "cutover written",
    CUTOVER_WAIT_MS,
  );
  expect(cutover).toMatchObject({ instanceId: first.instanceId });
  await until(async () => {
    const command = await scenario.controlCommand(status);
    return command?.queueStatus === "pending" ? undefined : command;
  }, "queued command polled once eligible");
  await scenario.rowWith(
    SERVER_A,
    (row) =>
      row.meetingId === waiting.meetingId &&
      JSON.stringify(row) !== JSON.stringify(waiting),
    "the waiting meeting taken by the finisher",
  );
  const { row } = await scenario.startRecording(SERVER_A, [waiting.meetingId]);
  expect(row.ownerInstanceId).toBe(first.instanceId);

  // The marker is permanent: a fresh old record changes nothing, and a later worker needs no wait.
  await scenario.world.seedLegacyRuntime(epochSeconds());
  const second = await scenario.startWorker({ release: 1, lifecycle: STANDBY });
  const { row: elsewhere } = await scenario.startRecording(
    SERVER_B,
    [],
    [second],
  );
  expect(elsewhere.ownerInstanceId).toBe(second.instanceId);
  await pause(REGISTRY_SETTLE_MS);
  await scenario.button(
    "end_meeting",
    await scenario.startMessageOf(SERVER_A, row.meetingId),
    SERVER_A,
  );
  await scenario.leaseGone(SERVER_A);
  // The first worker alone still takes a start while the old record is fresh.
  const { row: again } = await scenario.startRecording(
    SERVER_A,
    [row.meetingId, waiting.meetingId],
    [first],
  );
  expect(again).toMatchObject({
    status: "in_progress",
    ownerInstanceId: first.instanceId,
  });
  expect(
    await scenario.world.rows.get("DeploymentControlTable", CUTOVER_KEY),
  ).toEqual(cutover);
  expect(scenario.alarms()).toEqual([]);
});

test("with no eligible worker a start gets no response and writes nothing, and nothing is left behind once a worker becomes eligible", async () => {
  await scenario.world.seedLegacyRuntime(epochSeconds());
  await scenario.startWorker({ release: 1, lifecycle: STANDBY });
  await scenario.joinVoice(SERVER_A);
  const refused = await scenario.command("startmeeting", SERVER_A);

  expect(refused.responses).toEqual([]);
  expect(
    scenario.world.discord.rest
      .requests()
      .filter((call) => call.method !== "GET"),
  ).toEqual([]);
  expect(await scenario.rows(SERVER_A)).toEqual([]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(
    await scenario.world.rows.get("InteractionReceiptTable", {
      interactionId: refused.id,
    }),
  ).toBeUndefined();

  await until(
    () => scenario.world.rows.get("DeploymentControlTable", CUTOVER_KEY),
    "cutover written",
    CUTOVER_WAIT_MS,
  );
  await pause(REGISTRY_SETTLE_MS);
  expect(await scenario.rows(SERVER_A)).toEqual([]);
  expect(await scenario.world.rows.lease(SERVER_A.guildId)).toBeUndefined();
  expect(scenario.world.discord.rest.posts()).toEqual([]);
  const { row } = await scenario.startRecording(SERVER_A);
  expect(row.status).toBe("in_progress");
  expect(scenario.alarms()).toEqual([]);
});
