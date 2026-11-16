/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/analyticsService");
jest.mock("../../src/services/notesService");
jest.mock("../../src/services/meetingSummaryService");
jest.mock("../../src/services/meetingNameService");

import * as meetingDelivery from "../../src/services/meetingDelivery";
import * as embed from "../../src/embed";
import { initialMeetingUpdatePolicy } from "../../src/types/meetingPublication";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { nextDeliveryRetry } from "../../src/services/meetingFinish";
import { captureEvent } from "../../src/services/analyticsService";
import { MEETING_DELIVERY_FAILED_LOG } from "../../src/metrics";
import type { MeetingHistory } from "../../src/types/db";
import { expectSettledAndUnpublished } from "../fixtures/meetingFinishPipeline";
import { DONE_MARKER, UPGRADE } from "./meetingDelivery.fixture";
import {
  CHECKPOINT,
  FORBIDDEN,
  SERVER_ERROR,
  START_SECONDS,
  errorsLogged,
  exists,
  finishInput,
  loads,
  processingRow,
  recordingDirectory,
  setup,
  startMessage,
  useMeetingFinishHooks,
  type FinishWorld,
} from "./meetingFinish.fixture";

useMeetingFinishHooks();

const respondWith = (status: number) => () => new Response("{}", { status });

/** Moves the pending delivery retry to the give-up time and runs it. */
async function retryAtGiveUp(world: FinishWorld) {
  world.current().finish = {
    ...world.current().finish!,
    nextAttemptAt: START_SECONDS + LIFECYCLE.deliveryGiveUpSeconds,
  };
  await world.finish(loads(finishInput()));
}

test("delivery backoff then hourly then give up at 24 hours", () => {
  const since = 1_000;
  const retry = (attempts: number, now: number) =>
    nextDeliveryRetry({ attempts, deliverSince: since }, now);
  expect(retry(0, since)).toBe(since + 60);
  expect(retry(1, since + 60)).toBe(since + 360);
  expect(retry(2, since + 360)).toBe(since + 1_260);
  expect(retry(3, since + 1_260)).toBe(since + 4_860);
  expect(retry(10, since + 30_000)).toBe(since + 33_600);
  const lastHour = since + LIFECYCLE.deliveryGiveUpSeconds - 600;
  expect(retry(20, lastHour)).toBe(since + LIFECYCLE.deliveryGiveUpSeconds);
  expect(retry(21, since + LIFECYCLE.deliveryGiveUpSeconds)).toBeUndefined();
  expect(nextDeliveryRetry({ attempts: 0 }, since)).toBe(since + 60);
});

test("an attempt aborted before delivery claims no upgrade receipt", async () => {
  const world = setup(processingRow());
  const external = new AbortController();
  const save = world.deps.repository.save;
  world.deps.repository.save = async (...args) => {
    const saved = await save(...args);
    if (saved?.status === "complete") external.abort();
    return saved;
  };
  await world.finish(loads(finishInput()), { signal: external.signal });
  expect(world.current().status).toBe("complete");
  expect(world.deps.claimUpgrade).not.toHaveBeenCalled();
  expect(world.discord.requests).toHaveLength(0);
});

test("a temporary Discord error keeps the terminal status and retries delivery from its first failure", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = respondWith(SERVER_ERROR);
  await world.finish(loads(finishInput()));
  const first = world.current().finish;
  expect(world.current().status).toBe("complete");
  expect(first).toMatchObject({
    attempts: 1,
    phase: "deliver",
    deliverSince: START_SECONDS,
    nextAttemptAt: START_SECONDS + 60,
  });
  await world.finish(loads(finishInput()));
  expect(world.current().finish).toMatchObject({
    attempts: 2,
    deliverSince: START_SECONDS,
  });
  world.discord.state.fail = undefined;
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({ recovery: DONE_MARKER });
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(0);
});

test("a permanent Discord error marks delivery failed without the alarm log", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = respondWith(FORBIDDEN);
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "complete",
    delivery: {
      notes: {
        outcome: "failed",
        sent: 0,
        errors: [{ status: FORBIDDEN }],
      },
    },
  });
  expect(world.current().finish).toBeUndefined();
  expect(world.current().recovery).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(0);
});

test("a temporary Discord error past the give-up time marks delivery failed with the alarm log", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = respondWith(SERVER_ERROR);
  await world.finish(loads(finishInput()));
  await retryAtGiveUp(world);
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
});

test("deliver false posts nothing and leaves no finish marker", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput()), { deliver: false });
  expect(world.current().status).toBe("complete");
  expect(initialMeetingUpdatePolicy(world.current())).toEqual({
    kind: "unpublished",
  });
  expect(world.current().delivery).toBeUndefined();
  expect(world.current().recovery).toBeUndefined();
  expect(world.current().finish).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
  expect(world.deps.followOns.sendWeeklyLimitNotice).not.toHaveBeenCalled();
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(1);
});

test("the upgrade offer is shown with the summary and its delivery recorded", async () => {
  const world = setup(processingRow());
  jest.mocked(world.deps.claimUpgrade).mockResolvedValue(UPGRADE);
  await world.finish(loads(finishInput()));
  expect(JSON.stringify(startMessage(world).components)).toContain(UPGRADE.url);
  expect(
    jest
      .mocked(captureEvent)
      .mock.calls.filter(([name]) => name === "upgrade_offer_delivered")
      .map(([, event]) => event?.properties?.surface),
  ).toEqual(["discord_summary", "discord_notes"]);
});

test("an upgrade lookup failure never blocks delivery", async () => {
  const world = setup(processingRow());
  jest
    .mocked(world.deps.claimUpgrade)
    .mockRejectedValue(new Error("Synthetic billing outage"));
  await world.finish(loads(finishInput()));
  expect(world.current().recovery).toEqual(DONE_MARKER);
});

test("a worker stopped after delivery settles: the next attempt exports to Notion, uploads the recording and releases", async () => {
  const world = setup(processingRow({ checkpoint: CHECKPOINT }));
  let stopped: () => void = () => undefined;
  const reachedFollowOns = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  jest
    .mocked(world.deps.followOns.writeUserIndex)
    .mockImplementationOnce(() => {
      stopped();
      return new Promise(() => undefined);
    });
  void world.finish(loads(finishInput()));
  await reachedFollowOns;
  expect(world.current().recovery).toEqual(DONE_MARKER);
  expect(world.deps.followOns.exportToNotion).not.toHaveBeenCalled();

  world.advance((LIFECYCLE.finishClaimSeconds + 1) * 1000);
  const { directory, recordingPath } = await recordingDirectory();
  const load = loads(finishInput({ recordingPath, localDirectory: directory }));
  await world.finish(load);
  expect(load).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(1);
  expect(world.current().audioS3Key).toMatch(/audio_combined\.mp3$/);
  expect(world.current().finish).toBeUndefined();
  expect(await exists(directory)).toBe(false);
  expect(world.deps.followOns.captureCompleted).not.toHaveBeenCalled();
});

test("analytics and the weekly notice are not repeated on a settled row", async () => {
  const world = setup(processingRow());
  await world.finish(loads(finishInput({ source: "normal" })));
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledTimes(1);
  world.current().finish = { attempts: 0, phase: "deliver" };
  await world.finish(loads(finishInput({ source: "normal" })));
  expect(world.deps.followOns.captureCompleted).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.sendWeeklyLimitNotice).toHaveBeenCalledTimes(1);
  expect(world.deps.followOns.exportToNotion).toHaveBeenCalledTimes(2);
});

test("an unexpected error during delivery is counted and gives up at 24 hours", async () => {
  const world = setup(processingRow());
  jest
    .spyOn(meetingDelivery, "deliverMeeting")
    .mockRejectedValue(new Error("Synthetic render defect"));
  await world.finish(loads(finishInput()));
  expect(world.current().finish).toMatchObject({
    attempts: 1,
    phase: "deliver",
    deliverSince: START_SECONDS,
  });
  await retryAtGiveUp(world);
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().finish).toBeUndefined();
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
});

test("a correction made while delivery is pending is held and delivered after delivery completes", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = respondWith(SERVER_ERROR);
  await world.finish(loads(finishInput()));
  expect(world.current().status).toBe("complete");
  await expect(world.correct("Synthetic edit")).resolves.toMatchObject({
    kind: "saved",
  });
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  world.discord.state.fail = undefined;
  await world.finish(loads(finishInput()));
  expect(world.current().recovery).toEqual(DONE_MARKER);
  expect(world.current().updateDelivery?.policy).toEqual({ kind: "active" });
  expect(world.current().updateDeliveryDueAt).toBeDefined();
});

test("a correction held when delivery is given up is released as unpublished", async () => {
  const world = setup(processingRow());
  world.discord.state.fail = respondWith(SERVER_ERROR);
  await world.finish(loads(finishInput()));
  await world.correct("Synthetic edit");
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  world.discord.state.fail = respondWith(FORBIDDEN);
  await world.finish(loads(finishInput()));
  expect(world.current().delivery?.notes?.outcome).toBe("failed");
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "unpublished",
  });
  expect(world.current().finish).toBeUndefined();
});

test("delivery gives up at 24 hours even when rendering the notes throws", async () => {
  const world = setup(processingRow());
  jest.spyOn(embed, "buildMeetingResultMessages").mockImplementation(() => {
    throw new Error("Synthetic renderer defect");
  });
  const done = jest.spyOn(world.deps.repository, "releaseDone");
  await world.finish(loads(finishInput()));
  expect(world.current()).toMatchObject({
    status: "complete",
    finish: { attempts: 1, phase: "deliver" },
  });
  await retryAtGiveUp(world);
  expect(world.current().delivery?.notes).toMatchObject({
    outcome: "failed",
    sent: 0,
  });
  expect(errorsLogged(MEETING_DELIVERY_FAILED_LOG)).toBe(1);
  expect(done).toHaveBeenCalledTimes(1);
  expect(world.current().finish).toBeUndefined();
});

test("a row with no text channel is not held while its delivery is pending", () => {
  const pending = processingRow({
    status: "complete",
    notes: "- Synthetic note.",
    finish: { attempts: 0, phase: "deliver" },
  });
  expect(initialMeetingUpdatePolicy(pending)).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  expect(
    initialMeetingUpdatePolicy({ ...pending, textChannelId: undefined }),
  ).toEqual({ kind: "unpublished" });
});

test("a correction made during a deliver false attempt is released as unpublished", async () => {
  const world = setup(processingRow());
  let heldDuringAttempt: unknown;
  jest
    .mocked(world.deps.followOns.writeUserIndex)
    .mockImplementationOnce(async () => {
      await world.correct("Synthetic edit");
      heldDuringAttempt = world.current().updateDelivery?.policy;
    });
  await world.finish(loads(finishInput()), { deliver: false });
  expect(heldDuringAttempt).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
  expect(world.current().updateDelivery?.policy).toEqual({
    kind: "unpublished",
  });
  expect(world.current().finish).toBeUndefined();
  expect(world.discord.requests).toHaveLength(0);
});

describe("deliver false leaves the meeting settled and unpublished", () => {
  const leftoverRecovery = {
    disposition: "pending" as const,
    attempt: 0,
    executionVersion: 1,
    stage: "verification" as const,
    retry: { maxAttempts: 3, nextAttemptAt: null },
  };
  const rows: Record<string, () => MeetingHistory> = {
    "a row the old runtime stranded with a recovery value": () =>
      processingRow({
        lifecycleVersion: undefined,
        recovery: leftoverRecovery,
      }),
    "a row of the lifecycle design": () => processingRow(),
  };

  test.each(Object.entries(rows))("%s", async (_, row) => {
    const world = setup(row());
    await world.finish(loads(finishInput()), { deliver: false });
    expect(world.current().status).toBe("complete");
    expectSettledAndUnpublished(world.current());
    // A later correction is stored and not sent.
    await world.correct("Synthetic edit");
    expect(world.current()).toMatchObject({
      meetingName: "Synthetic edit",
      updateDelivery: { policy: { kind: "unpublished" } },
    });
    expect(world.discord.requests).toHaveLength(0);
  });

  test("an old row whose notes delivery already failed loses its leftover recovery value too", async () => {
    const world = setup(
      processingRow({
        lifecycleVersion: undefined,
        status: "complete",
        notes: "- Synthetic note.",
        processing: {
          transcription: "ready",
          notes: "generated",
          summary: "generated",
        },
        recovery: leftoverRecovery,
        delivery: {
          notes: { outcome: "failed", intended: 1, sent: 0, errors: [] },
        },
      }),
    );
    await world.finish(loads(finishInput()), { deliver: false });
    expect(world.current().status).toBe("complete");
    expect(world.current().delivery?.notes?.outcome).toBe("failed");
    expectSettledAndUnpublished(world.current());
  });

  test("a delivered finish of an old row writes the done marker as before", async () => {
    const world = setup(
      rows["a row the old runtime stranded with a recovery value"](),
    );
    await world.finish(loads(finishInput()));
    expect(world.current().recovery).toEqual(DONE_MARKER);
  });
});
