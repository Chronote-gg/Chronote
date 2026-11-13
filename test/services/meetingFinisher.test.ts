/** @jest-environment node */
jest.mock("../../src/observability/meetingTrace", () => ({
  ...jest.requireActual("../../src/observability/meetingTrace"),
  withMeetingEndTrace: jest.fn(
    async (_meeting: unknown, run: () => Promise<void>) => run(),
  ),
}));
import { withMeetingEndTrace } from "../../src/observability/meetingTrace";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import type { FinishInput } from "../../src/services/meetingFinishInput";
import { classifyFinisherRow } from "../../src/services/meetingFinisher";
import {
  createMeetingFinisher,
  type MeetingFinishDeps,
} from "../../src/services/meetingFinish";
import { MEETING_STUCK_LOG } from "../../src/metrics";
import { stubFollowOns } from "../fixtures/meetingFinishPipeline";
import {
  CLAIM,
  MS_PER_SECOND,
  NOW,
  claimedBy,
  finisherRow,
  flush,
  isoAt,
  localMeeting,
  logged,
  row,
  setup,
  useFinisherHooks,
} from "./meetingFinisher.fixture";

useFinisherHooks();

test("the loop never takes more than the free slots", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local, row("a"), row("b"), row("c")]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(LIFECYCLE.maxConcurrentFinishes);
  expect(world.deps.finish).toHaveBeenCalledTimes(
    LIFECYCLE.maxConcurrentFinishes,
  );
  await world.settle();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("a local finish always starts, even with every slot taken", async () => {
  const locals = [row("a"), row("b"), row("c")].map((history) => ({
    ...history,
    finish: claimedBy(`synthetic-worker-b:${history.meetingId}`),
  }));
  const world = setup(locals);
  for (const history of locals)
    void world.loop.runLocalFinish(
      localMeeting(history),
      `synthetic-worker-b:${history.meetingId}`,
    );
  await flush();
  expect(world.loop.activeFinishCount()).toBe(locals.length);
  await world.settle();
});

test("a meeting is reported as finishing here only while its attempt runs", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const looped = row("b");
  const world = setup([local, looped]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await world.scan();
  await flush();
  expect(world.loop.isFinishing(local.meetingId)).toBe(true);
  expect(world.loop.isFinishing(looped.meetingId)).toBe(true);
  expect(world.loop.isFinishing("synthetic-elsewhere")).toBe(false);
  await world.settle();
  expect(world.loop.isFinishing(local.meetingId)).toBe(false);
  expect(world.loop.isFinishing(looped.meetingId)).toBe(false);
});

test("a meeting this process is already finishing is skipped", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  // Renewals failed for longer than the claim, so the row looks claimable.
  world.advance(CLAIM + 1);
  await world.scan();
  await flush();
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  expect(world.current(local).finish?.owner).toBe("synthetic-worker-b:local");
  await world.settle();
});

test("the local finish uses the normal loader and a loop attempt uses the recovery loader", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const stranded = row("stranded");
  const world = setup([local, stranded]);
  const meeting = localMeeting(local);
  void world.loop.runLocalFinish(meeting, "synthetic-worker-b:local");
  await flush();
  await world.scan();
  await flush();
  expect(world.deps.loadNormal).toHaveBeenCalledTimes(1);
  expect(world.deps.loadNormal).toHaveBeenCalledWith(
    meeting,
    expect.any(AbortSignal),
  );
  expect(world.deps.loadRecovery).toHaveBeenCalledTimes(1);
  expect(jest.mocked(world.deps.loadRecovery).mock.calls[0][0]).toMatchObject({
    meetingId: stranded.meetingId,
  });
  const [localClaim, loopClaim] = world.pending.map((p) => p.claim);
  expect(localClaim).toMatchObject({
    owner: "synthetic-worker-b:local",
    history: { meetingId: local.meetingId },
  });
  expect(loopClaim.owner).toMatch(/^synthetic-worker-b:[0-9a-f-]{36}$/);
  await world.settle();
});

test("the local finish runs inside the meeting-end trace", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([local]);
  const meeting = localMeeting(local);
  let tracing = false;
  jest
    .mocked(withMeetingEndTrace)
    .mockImplementationOnce(async (_traced, run) => {
      tracing = true;
      try {
        await run();
      } finally {
        tracing = false;
      }
    });
  let finishedInsideTrace: boolean | undefined;
  const finish = jest.mocked(world.deps.finish);
  const held = finish.getMockImplementation();
  finish.mockImplementationOnce((...args) => {
    finishedInsideTrace = tracing;
    return held!(...args);
  });

  const finished = world.loop.runLocalFinish(
    meeting,
    "synthetic-worker-b:local",
  );
  await flush();
  await world.settle();
  await finished;

  expect(withMeetingEndTrace).toHaveBeenCalledWith(
    meeting,
    expect.any(Function),
  );
  expect(finishedInsideTrace).toBe(true);
});

test("a local finish reports whether its normal loader took the meeting", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-b:local") });
  const gone = row("b", { finish: claimedBy("synthetic-worker-c:other") });
  const world = setup([local, gone]);
  const loaded = world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.settle();
  await expect(loaded).resolves.toBe(true);
  await expect(
    world.loop.runLocalFinish(localMeeting(gone), "synthetic-worker-b:local"),
  ).resolves.toBe(false);
});

test.each(["succeeds", "fails in its loader", "finds its claim gone"] as const)(
  "a local finish that %s leaves no encoder behind",
  async (outcome) => {
    const owner = "synthetic-worker-b:local";
    const local = row("a", {
      finish: claimedBy(
        outcome === "finds its claim gone" ? "synthetic-worker-c:other" : owner,
      ),
    });
    const world = setup([local]);
    if (outcome === "fails in its loader")
      jest
        .mocked(world.deps.loadNormal)
        .mockRejectedValue(new Error("synthetic loader failure"));
    const meeting = localMeeting(local);
    const finished = world.loop.runLocalFinish(meeting, owner);
    await flush();
    await world.settle();
    await finished;
    expect(world.deps.endEncoder).toHaveBeenCalledWith(meeting);
  },
);

test("a local finish whose claim is gone does not run", async () => {
  const local = row("a", { finish: claimedBy("synthetic-worker-c:other") });
  const world = setup([local]);
  await world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("each claim carries its own owner", async () => {
  const world = setup([row("a"), row("b")]);
  await world.scan();
  await flush();
  const owners = world.pending.map((p) => p.claim.owner);
  expect(new Set(owners).size).toBe(2);
  await world.settle();
});

test("a local finish for a meeting the loop is already finishing does not start a second attempt", async () => {
  const meeting = row("a");
  const world = setup([meeting]);
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.loop.runLocalFinish(
    localMeeting(meeting),
    "synthetic-worker-b:local",
  );
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  expect(world.loop.activeFinishCount()).toBe(1);
  await world.settle();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("shutdown aborts a running attempt before releasing its claim and the attempt makes no further save or Discord call", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const events: string[] = [];
  const posted = jest.fn();
  let save: jest.SpyInstance | undefined;
  const world = setup([local], (repository) => {
    save = jest.spyOn(repository, "save");
    const release = repository.releaseUnclaimed;
    repository.releaseUnclaimed = async (claim) => {
      events.push("released");
      await release(claim);
    };
    return createMeetingFinisher({
      repository,
      transport: new Proxy({} as MeetingFinishDeps["transport"], {
        get: () => posted,
      }),
      upload: jest.fn(),
      notes: jest.fn(),
      summaries: jest.fn(),
      claimUpgrade: jest.fn(async () => undefined),
      followOns: stubFollowOns(),
      nowMs: () => NOW * MS_PER_SECOND,
      schedule: () => () => undefined,
    }).finishMeeting;
  });
  // The normal loader is mid-way through, for example compiling the transcript.
  jest.mocked(world.deps.loadNormal).mockImplementation(
    (_meeting, signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            events.push("aborted");
            resolve({ hasSavedAudio: true } as FinishInput);
          },
          { once: true },
        ),
      ),
  );
  const finished = world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();

  await world.loop.releaseLocalFinishClaims();
  await finished;

  expect(events).toEqual(["aborted", "released"]);
  expect(save).not.toHaveBeenCalled();
  expect(posted).not.toHaveBeenCalled();
  expect(world.current(local).finish).toEqual({
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  });
});

test("no attempt starts after shutdown began", async () => {
  const stranded = row("a");
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const world = setup([stranded, local]);
  const claim = world.deps.repository.claim;
  let letClaimLand = () => undefined as void;
  const landing = new Promise<void>((resolve) => {
    letClaimLand = resolve;
  });
  jest
    .spyOn(world.deps.repository, "claim")
    .mockImplementationOnce(async (...args) => {
      await landing;
      return claim(...args);
    });
  await world.scan();
  expect(world.loop.activeFinishCount()).toBe(1);

  const shutdown = world.loop.releaseLocalFinishClaims();
  letClaimLand();
  await shutdown;
  await world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await world.scan();
  await flush();

  expect(world.deps.finish).not.toHaveBeenCalled();
  expect(world.current(stranded).finish?.owner).toBeUndefined();
  expect(world.current(local).finish?.owner).toBeUndefined();
  expect(world.loop.activeFinishCount()).toBe(0);
});

test("shutdown releases claims without counting an attempt", async () => {
  const local = row("local", { finish: claimedBy("synthetic-worker-b:local") });
  const retried = row("retried", {
    finish: { attempts: 2, nextAttemptAt: NOW, phase: "process" },
  });
  const world = setup([local, retried]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.scan();
  await flush();
  expect(world.loop.activeFinishCount()).toBe(2);

  await world.loop.releaseLocalFinishClaims();

  expect(world.current(local).finish).toEqual({
    attempts: 0,
    startedAt: NOW,
    phase: "process",
  });
  expect(world.current(retried).finish).toEqual({
    attempts: 2,
    startedAt: NOW,
    phase: "process",
  });
  // Another worker may take them at once.
  expect(
    classifyFinisherRow(finisherRow(world.current(local)), undefined, NOW),
  ).toBe("claim");
  world.advance(1);
  await world.scan();
  await flush();
  expect(world.deps.finish).toHaveBeenCalledTimes(2);
  await world.settle();
});

test("a row this process is finishing still logs the stuck line", async () => {
  const local = row("a", {
    timestamp: isoAt(NOW - LIFECYCLE.stuckAlarmSeconds - 1),
    finish: claimedBy("synthetic-worker-b:local"),
  });
  const world = setup([local]);
  void world.loop.runLocalFinish(
    localMeeting(local),
    "synthetic-worker-b:local",
  );
  await flush();
  await world.scan();
  expect(logged(MEETING_STUCK_LOG)).toBe(1);
  expect(world.deps.finish).toHaveBeenCalledTimes(1);
  await world.settle();
});
