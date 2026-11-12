/** @jest-environment node */
import { meetingLeaseEvents } from "../../src/metrics";
import { createMockMeetingLeaseRepository } from "../../src/repositories/meetingLeaseRepository";
import {
  leaseCapEpochSeconds,
  LIFECYCLE,
} from "../../src/services/lifecycleTiming";
import {
  createMeetingLeaseService,
  type AcquireSessionLeaseInput,
} from "../../src/services/meetingLease";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { DeploymentControlRecord } from "../../src/types/deploymentControl";
import type { SessionReservation } from "../../src/types/meetingHistoryTransition";
import {
  historyRow,
  leaseRecord,
  suppressionRecord,
} from "../repositories/meetingLeaseRepository.contract";

const MS_PER_SECOND = 1000;
const START_SECONDS = 1_000_000;
const OWNER = "synthetic-owner-a";
const GUILD = "synthetic-guild";
const MAX_DURATION_MS = 60 * 60_000;

function setup() {
  const leases = new Map<string, ActiveMeetingLease>();
  const histories = new Map<string, MeetingHistory[]>();
  const records = new Map<string, DeploymentControlRecord>();
  const repository = createMockMeetingLeaseRepository(
    leases,
    histories,
    records,
  );
  let nowMs = START_SECONDS * MS_PER_SECOND;
  let pending: (() => Promise<void>) | undefined;
  const requests: AbortController[] = [];
  const delay = jest.fn(async () => undefined);
  const service = createMeetingLeaseService({
    requestSignal() {
      const controller = new AbortController();
      requests.push(controller);
      return controller.signal;
    },
    delay,
    repository,
    instanceId: () => OWNER,
    nowMs: () => nowMs,
    schedule(run, delayMs) {
      expect(delayMs).toBe(LIFECYCLE.leaseHeartbeatMs);
      pending = run;
      return () => {
        pending = undefined;
      };
    },
  });
  const hooks = {
    maxDurationMs: MAX_DURATION_MS,
    snapshot: () => ({ status: "in_progress" as const }),
    onEndRequested: jest.fn(),
    onLost: jest.fn(),
    onCapReached: jest.fn(),
  };
  async function tick(advanceMs = LIFECYCLE.leaseHeartbeatMs) {
    nowMs += advanceMs;
    const run = pending;
    if (!run) throw new Error("No renewal is scheduled");
    pending = undefined;
    await run();
  }
  function startInput(): AcquireSessionLeaseInput {
    const history = historyRow();
    return {
      guildId: GUILD,
      meetingId: history.meetingId,
      voiceChannelId: "synthetic-voice",
      textChannelId: "synthetic-text",
      isAutoRecording: false,
      reservedAt: nowMs,
      sessionMode: "meeting",
      history: {
        ...history,
        status: "in_progress",
        ownerInstanceId: undefined,
        executionVersion: undefined,
        lifecycleVersion: undefined,
      },
    };
  }
  async function acquire(): Promise<SessionReservation> {
    const result = await service.acquireSessionLease(startInput());
    if (result.kind !== "admitted") throw new Error("Expected admission");
    return result.reservation;
  }
  return {
    leases,
    histories,
    records,
    repository,
    service,
    hooks,
    tick,
    acquire,
    startInput,
    requests,
    delay,
    scheduled: () => pending !== undefined,
    seconds: () => Math.floor(nowMs / MS_PER_SECOND),
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

let events: jest.SpyInstance;
beforeEach(() => {
  events = jest.spyOn(meetingLeaseEvents, "inc");
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
const counted = (event: string) =>
  events.mock.calls.filter(([labels]) => labels.event === event).length;
/** A lease another meeting in the same guild still holds. */
const otherMeetingLiveLease = () =>
  leaseRecord({
    meetingId: "synthetic-meeting-b",
    leaseExpiresAt: START_SECONDS + 1,
  });
/** The caller heard about the stop request exactly once, naming the user who asked. */
function expectEndRequestHandedOnce(
  hooks: ReturnType<typeof setup>["hooks"],
  userId: string,
) {
  expect(hooks.onEndRequested).toHaveBeenCalledTimes(1);
  expect(hooks.onEndRequested).toHaveBeenCalledWith(
    expect.objectContaining({ endRequestedByUserId: userId }),
  );
}

describe("acquireSessionLease", () => {
  it("writes the lease and a lifecycle 2 history row in one admission", async () => {
    const t = setup();
    const reservation = await t.acquire();
    expect(reservation).toEqual({
      guildId: GUILD,
      meetingId: "synthetic-meeting-a",
      ownerInstanceId: OWNER,
      executionVersion: 1,
      voiceOperationAttemptId: expect.any(String),
      reservedAt: START_SECONDS * MS_PER_SECOND,
      sessionMode: "meeting",
      historyKey: {
        guildId: GUILD,
        channelId_timestamp: historyRow().channelId_timestamp,
      },
    });
    expect(t.leases.get(GUILD)).toMatchObject({
      meetingId: "synthetic-meeting-a",
      ownerInstanceId: OWNER,
      executionVersion: 1,
      sessionMode: "meeting",
      voiceOperationAttemptId: reservation.voiceOperationAttemptId,
      status: "starting",
      leaseExpiresAt: START_SECONDS + LIFECYCLE.leaseSeconds,
      expiresAt:
        START_SECONDS + LIFECYCLE.leaseSeconds + LIFECYCLE.leaseTtlGraceSeconds,
    });
    expect(t.histories.get(GUILD)).toEqual([
      expect.objectContaining({
        status: "starting",
        ownerInstanceId: OWNER,
        executionVersion: 1,
        lifecycleVersion: 2,
      }),
    ]);
  });

  it("is blocked by a live lease", async () => {
    const t = setup();
    t.leases.set(GUILD, otherMeetingLiveLease());
    await expect(
      t.service.acquireSessionLease(t.startInput()),
    ).resolves.toEqual({ kind: "blocked", reason: "active_session" });
    expect(t.histories.size).toBe(0);
  });

  const conflict = () =>
    Object.assign(new Error("synthetic conflict"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }],
    });

  it("retries a start cancelled for conflict with the same token", async () => {
    const t = setup();
    const start = jest
      .spyOn(t.repository, "startSession")
      .mockRejectedValueOnce(conflict());
    await expect(
      t.service.acquireSessionLease(t.startInput()),
    ).resolves.toMatchObject({ kind: "admitted" });
    expect(start).toHaveBeenCalledTimes(2);
    const [first, second] = start.mock.calls.map(([request]) => request);
    expect(second.lease.voiceOperationAttemptId).toBe(
      first.lease.voiceOperationAttemptId,
    );
    expect(second.now).toBe(first.now);
    expect(t.delay).toHaveBeenCalledWith(LIFECYCLE.startConflictRetryMs);
  });

  it("a start that keeps conflicting yields to another meeting's live lease", async () => {
    const t = setup();
    const start = jest
      .spyOn(t.repository, "startSession")
      .mockRejectedValue(conflict());
    t.leases.set(GUILD, otherMeetingLiveLease());
    await expect(
      t.service.acquireSessionLease(t.startInput()),
    ).resolves.toEqual({ kind: "blocked", reason: "active_session" });
    expect(start).toHaveBeenCalledTimes(LIFECYCLE.closeWriteAttempts);
  });

  it("a start that keeps conflicting with no live lease rethrows", async () => {
    const t = setup();
    jest.spyOn(t.repository, "startSession").mockRejectedValue(conflict());
    await expect(t.service.acquireSessionLease(t.startInput())).rejects.toThrow(
      "synthetic conflict",
    );
  });

  /** Writes through the real repository when asked, then hangs until the request bound aborts it. */
  function timedOutStart(
    t: ReturnType<typeof setup>,
    options: { commit: boolean },
  ) {
    const realStart = t.repository.startSession;
    return jest
      .spyOn(t.repository, "startSession")
      .mockImplementation(async (request) => {
        if (options.commit) await realStart(request);
        t.requests[t.requests.length - 1].abort(new Error("synthetic timeout"));
        return new Promise<never>(() => undefined);
      });
  }

  it("a start whose commit landed but whose response timed out is admitted", async () => {
    const t = setup();
    timedOutStart(t, { commit: true });
    const result = await t.service.acquireSessionLease(t.startInput());
    if (result.kind !== "admitted") throw new Error("Expected admission");
    expect(t.leases.get(GUILD)?.voiceOperationAttemptId).toBe(
      result.reservation.voiceOperationAttemptId,
    );
    expect(t.histories.get(GUILD)).toHaveLength(1);
  });

  it("a start that timed out with no lease written rethrows", async () => {
    const t = setup();
    timedOutStart(t, { commit: false });
    await expect(t.service.acquireSessionLease(t.startInput())).rejects.toThrow(
      "synthetic timeout",
    );
  });

  it("a start that timed out while another meeting holds the lease is blocked", async () => {
    const t = setup();
    t.leases.set(GUILD, otherMeetingLiveLease());
    timedOutStart(t, { commit: false });
    await expect(
      t.service.acquireSessionLease(t.startInput()),
    ).resolves.toEqual({ kind: "blocked", reason: "active_session" });
  });

  it("an aborted caller signal stops the conflict retries", async () => {
    const t = setup();
    const caller = new AbortController();
    const start = jest
      .spyOn(t.repository, "startSession")
      .mockImplementation(async () => {
        caller.abort(new Error("synthetic caller abort"));
        throw conflict();
      });
    await expect(
      t.service.acquireSessionLease({
        ...t.startInput(),
        signal: caller.signal,
      }),
    ).rejects.toThrow("synthetic caller abort");
    expect(start).toHaveBeenCalledTimes(1);
    expect(t.delay).not.toHaveBeenCalled();
  });

  it("checks suppression at the version it observes", async () => {
    const t = setup();
    const input = {
      guildId: GUILD,
      meetingId: "synthetic-tts",
      voiceChannelId: "synthetic-voice",
      textChannelId: "synthetic-text",
      isAutoRecording: true,
      reservedAt: 0,
      sessionMode: "tts_only" as const,
      suppression: { channelId: "synthetic-voice" },
    };
    const seed = (suppressed: boolean) => {
      const record = suppressionRecord({
        guildId: GUILD,
        channelId: "synthetic-voice",
        version: 5,
        suppressed,
      });
      t.records.set(JSON.stringify([record.pk, record.sk]), record);
    };
    seed(true);
    await expect(t.service.acquireSessionLease(input)).resolves.toEqual({
      kind: "blocked",
      reason: "suppressed",
    });
    seed(false);
    await expect(t.service.acquireSessionLease(input)).resolves.toMatchObject({
      kind: "admitted",
      reservation: { sessionMode: "tts_only" },
    });
  });
});

describe("startLeaseRenewal", () => {
  it("renews every heartbeat with the caller's snapshot", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    await t.tick();
    expect(t.leases.get(GUILD)).toMatchObject({
      status: "in_progress",
      leaseExpiresAt: t.seconds() + LIFECYCLE.leaseSeconds,
    });
    expect(t.scheduled()).toBe(true);
  });

  it("renewal error keeps recording", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    jest
      .spyOn(t.repository, "renew")
      .mockRejectedValueOnce(new Error("synthetic outage"));
    await t.tick();
    expect(counted("renew_error")).toBe(1);
    expect(t.hooks.onLost).not.toHaveBeenCalled();
    expect(t.scheduled()).toBe(true);
    await t.tick();
    expect(t.leases.get(GUILD)?.leaseExpiresAt).toBe(
      t.seconds() + LIFECYCLE.leaseSeconds,
    );
  });

  it("condition failure with absent lease retakes", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    t.leases.delete(GUILD);
    await t.tick();
    expect(counted("retaken")).toBe(1);
    expect(t.leases.get(GUILD)).toMatchObject({
      meetingId: reservation.meetingId,
      ownerInstanceId: OWNER,
      voiceOperationAttemptId: reservation.voiceOperationAttemptId,
      status: "in_progress",
      leaseExpiresAt: t.seconds() + LIFECYCLE.leaseSeconds,
    });
    expect(t.hooks.onLost).not.toHaveBeenCalled();
    expect(t.scheduled()).toBe(true);
  });

  it("condition failure with an expired lease retakes after a stall", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    await t.tick(LIFECYCLE.leaseSeconds * MS_PER_SECOND * 2);
    expect(counted("retaken")).toBe(1);
    expect(t.leases.get(GUILD)?.leaseExpiresAt).toBe(
      t.seconds() + LIFECYCLE.leaseSeconds,
    );
  });

  it("a lease that lapsed just inside the adoption grace is still retaken", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    const expiry = t.leases.get(GUILD)!.leaseExpiresAt;
    t.advance((expiry - t.seconds()) * MS_PER_SECOND);
    await t.tick((LIFECYCLE.abandonedGraceSeconds - 1) * MS_PER_SECOND);
    expect(counted("retaken")).toBe(1);
    expect(t.hooks.onLost).not.toHaveBeenCalled();
  });

  it("a lease read that runs past the adoption grace is lost, measured when the read returns", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    const expiry = t.leases.get(GUILD)!.leaseExpiresAt;
    const realRead = t.repository.read;
    const slowReadMs = 10 * MS_PER_SECOND;
    jest
      .spyOn(t.repository, "read")
      .mockImplementationOnce(async (guildId, signal) => {
        t.advance(slowReadMs);
        return realRead(guildId, signal);
      });
    const retake = jest.spyOn(t.repository, "retake");
    t.advance((expiry - t.seconds()) * MS_PER_SECOND);
    await t.tick(
      LIFECYCLE.abandonedGraceSeconds * MS_PER_SECOND - slowReadMs / 2,
    );
    expect(retake).not.toHaveBeenCalled();
    expect(t.hooks.onLost).toHaveBeenCalledTimes(1);
  });

  it.each(["expired", "absent"])(
    "an %s lease that lapsed past the adoption grace is lost, not retaken",
    async (kind) => {
      const t = setup();
      const reservation = await t.acquire();
      t.service.startLeaseRenewal(reservation, t.hooks);
      const expiry = t.leases.get(GUILD)!.leaseExpiresAt;
      if (kind === "absent") t.leases.delete(GUILD);
      const before = t.leases.get(GUILD);
      const retake = jest.spyOn(t.repository, "retake");
      t.advance((expiry - t.seconds()) * MS_PER_SECOND);
      await t.tick(LIFECYCLE.abandonedGraceSeconds * MS_PER_SECOND);
      expect(retake).not.toHaveBeenCalled();
      expect(t.leases.get(GUILD)).toEqual(before);
      expect(t.hooks.onLost).toHaveBeenCalledTimes(1);
      expect(counted("lost")).toBe(1);
      expect(counted("retaken")).toBe(0);
      expect(t.scheduled()).toBe(false);
      await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
        "lost",
      );
    },
  );

  it("condition failure with another meeting calls onLost once", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    const other = leaseRecord({
      meetingId: "synthetic-meeting-b",
      ownerInstanceId: "synthetic-owner-b",
      voiceOperationAttemptId: "synthetic-attempt-b",
      leaseExpiresAt: START_SECONDS + 100,
    });
    t.leases.set(GUILD, other);
    await t.tick();
    expect(t.hooks.onLost).toHaveBeenCalledTimes(1);
    expect(counted("lost")).toBe(1);
    expect(t.scheduled()).toBe(false);
    expect(t.leases.get(GUILD)).toEqual(other);
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "lost",
    );
    expect(t.hooks.onLost).toHaveBeenCalledTimes(1);
  });

  it("no renewal past the cap", async () => {
    const t = setup();
    const reservation = await t.acquire();
    const cap = leaseCapEpochSeconds(reservation.reservedAt, MAX_DURATION_MS);
    t.service.startLeaseRenewal(reservation, t.hooks);
    let ticks = 0;
    while (t.scheduled()) {
      await t.tick();
      ticks++;
      expect(t.leases.get(GUILD)!.leaseExpiresAt).toBeLessThanOrEqual(cap);
    }
    expect(ticks).toBeGreaterThan(1);
    expect(t.leases.get(GUILD)!.leaseExpiresAt).toBe(cap);
    expect(t.hooks.onCapReached).toHaveBeenCalledTimes(1);
    expect(counted("cap")).toBe(1);
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "held",
    );
    expect(t.leases.get(GUILD)!.leaseExpiresAt).toBe(cap);
    t.advance((LIFECYCLE.leaseSeconds + 1) * MS_PER_SECOND);
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "capped",
    );
    expect(t.leases.get(GUILD)!.leaseExpiresAt).toBe(cap);
    expect(counted("lost")).toBe(0);
  });

  it("past the cap, a lease another meeting holds is lost", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    while (t.scheduled()) await t.tick();
    t.advance((LIFECYCLE.leaseSeconds + 1) * MS_PER_SECOND);
    t.leases.set(
      GUILD,
      leaseRecord({
        meetingId: "synthetic-meeting-b",
        voiceOperationAttemptId: "synthetic-attempt-b",
        leaseExpiresAt: t.seconds() + LIFECYCLE.leaseSeconds,
      }),
    );
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "lost",
    );
    expect(counted("lost")).toBe(1);
    expect(t.service.latestLeaseCap(t.seconds())).toBeUndefined();
  });

  it("a retake keeps a stop request written onto the expired lease", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    Object.assign(t.leases.get(GUILD)!, {
      endRequestedAt: "2026-01-01T00:01:00.000Z",
      endRequestedByUserId: "synthetic-user",
      endReason: "web_ui",
    });
    await t.tick(LIFECYCLE.leaseSeconds * MS_PER_SECOND * 2);
    expect(counted("retaken")).toBe(1);
    expect(t.leases.get(GUILD)).toMatchObject({
      endRequestedAt: "2026-01-01T00:01:00.000Z",
      endRequestedByUserId: "synthetic-user",
      endReason: "web_ui",
      leaseExpiresAt: t.seconds() + LIFECYCLE.leaseSeconds,
    });
    await t.tick();
    expectEndRequestHandedOnce(t.hooks, "synthetic-user");
  });

  it("a stop request that lands between the read and the retake reaches the caller once", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    const realRetake = t.repository.retake;
    const retake = jest
      .spyOn(t.repository, "retake")
      .mockImplementationOnce(async (lease, now, signal) => {
        Object.assign(t.leases.get(GUILD)!, {
          endRequestedAt: "2026-01-01T00:01:00.000Z",
          endRequestedByUserId: "synthetic-user",
        });
        return realRetake(lease, now, signal);
      });
    await t.tick(LIFECYCLE.leaseSeconds * MS_PER_SECOND * 2);
    expect(retake).toHaveBeenCalledTimes(2);
    expect(counted("retaken")).toBe(1);
    expect(t.leases.get(GUILD)).toMatchObject({
      endRequestedAt: "2026-01-01T00:01:00.000Z",
      leaseExpiresAt: t.seconds() + LIFECYCLE.leaseSeconds,
    });
    await t.tick();
    expect(t.hooks.onEndRequested).toHaveBeenCalledTimes(1);
  });

  it("a retake refused twice in one tick is unknown, not lost", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    jest.spyOn(t.repository, "retake").mockResolvedValue(false);
    await t.tick(LIFECYCLE.leaseSeconds * MS_PER_SECOND * 2);
    expect(counted("renew_error")).toBe(1);
    expect(counted("lost")).toBe(0);
    expect(t.hooks.onLost).not.toHaveBeenCalled();
    expect(t.scheduled()).toBe(true);
  });

  it("a renewal that never settles is an error and does not block release", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    jest
      .spyOn(t.repository, "renew")
      .mockReturnValue(new Promise<boolean>(() => undefined));
    const requestsBefore = t.requests.length;
    const ticking = t.tick();
    const released = t.service.releaseSessionLease(reservation);
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.repository.renew).toHaveBeenCalledTimes(1);
    t.requests[requestsBefore].abort(new Error("synthetic timeout"));
    await released;
    await ticking;
    expect(t.leases.has(GUILD)).toBe(false);
    expect(counted("renew_error")).toBe(1);
    expect(t.hooks.onLost).not.toHaveBeenCalled();
    expect(t.scheduled()).toBe(false);
  });

  it("release while a renewal is in flight leaves no lease and no next tick", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    let settle!: (renewed: boolean) => void;
    jest.spyOn(t.repository, "renew").mockReturnValue(
      new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    );
    const ticking = t.tick();
    const released = t.service.releaseSessionLease(reservation);
    settle(true);
    await Promise.all([ticking, released]);
    expect(t.leases.has(GUILD)).toBe(false);
    expect(t.scheduled()).toBe(false);
    expect(t.hooks.onEndRequested).not.toHaveBeenCalled();
  });

  it("hands a remote end request to the caller once", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    await t.tick();
    expect(t.hooks.onEndRequested).not.toHaveBeenCalled();
    Object.assign(t.leases.get(GUILD)!, {
      endRequestedAt: "2026-01-01T00:01:00.000Z",
      endRequestedByUserId: "synthetic-user",
    });
    await t.tick();
    await t.tick();
    expectEndRequestHandedOnce(t.hooks, "synthetic-user");
  });

  it("refuses a reservation it did not admit", () => {
    const t = setup();
    expect(() =>
      t.service.startLeaseRenewal(
        {
          guildId: GUILD,
          meetingId: "synthetic-unknown",
          ownerInstanceId: OWNER,
          executionVersion: 1,
          voiceOperationAttemptId: "synthetic-unknown-attempt",
          reservedAt: 0,
          sessionMode: "tts_only",
        },
        t.hooks,
      ),
    ).toThrow("not held");
  });
});

describe("confirmSessionLease", () => {
  it("renews, retakes an absent lease, and throws on error", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    t.advance(MS_PER_SECOND);
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "held",
    );
    t.leases.delete(GUILD);
    await expect(t.service.confirmSessionLease(reservation)).resolves.toBe(
      "held",
    );
    expect(t.leases.get(GUILD)?.meetingId).toBe(reservation.meetingId);
    jest
      .spyOn(t.repository, "renew")
      .mockRejectedValueOnce(new Error("synthetic outage"));
    await expect(t.service.confirmSessionLease(reservation)).rejects.toThrow(
      "synthetic outage",
    );
  });
});

describe("releaseSessionLease", () => {
  it("stops renewal and deletes the lease", async () => {
    const t = setup();
    const reservation = await t.acquire();
    t.service.startLeaseRenewal(reservation, t.hooks);
    await t.service.releaseSessionLease(reservation);
    expect(t.leases.has(GUILD)).toBe(false);
    expect(t.scheduled()).toBe(false);
    await expect(
      t.service.releaseSessionLease(reservation),
    ).resolves.toBeUndefined();
  });
});

describe("latestLeaseCap", () => {
  it("latestLeaseCap ignores voice-only sessions", async () => {
    const t = setup();
    const input = t.startInput();
    const result = await t.service.acquireSessionLease({
      guildId: input.guildId,
      meetingId: input.meetingId,
      voiceChannelId: input.voiceChannelId,
      textChannelId: input.textChannelId,
      isAutoRecording: false,
      reservedAt: input.reservedAt,
      sessionMode: "tts_only",
    });
    if (result.kind !== "admitted") throw new Error("Expected admission");
    t.service.startLeaseRenewal(result.reservation, t.hooks);
    expect(t.service.latestLeaseCap(t.seconds())).toBeUndefined();
    expect(t.service.holdsSessionLease(result.reservation)).toBe(true);
  });

  it("reports what it holds and the last confirmed expiry", async () => {
    const t = setup();
    const reservation = await t.acquire();
    expect(t.service.holdsSessionLease(reservation)).toBe(true);
    expect(t.service.confirmedLeaseExpiry(reservation)).toBe(
      START_SECONDS + LIFECYCLE.leaseSeconds,
    );
    await t.service.releaseSessionLease(reservation);
    expect(t.service.holdsSessionLease(reservation)).toBe(false);
    expect(t.service.confirmedLeaseExpiry(reservation)).toBeUndefined();
  });

  it("is the cap of reservations still renewed and unexpired", async () => {
    const t = setup();
    expect(t.service.latestLeaseCap(t.seconds())).toBeUndefined();
    const reservation = await t.acquire();
    expect(t.service.latestLeaseCap(t.seconds())).toBeUndefined();
    t.service.startLeaseRenewal(reservation, t.hooks);
    const cap = leaseCapEpochSeconds(reservation.reservedAt, MAX_DURATION_MS);
    expect(t.service.latestLeaseCap(t.seconds())).toBe(cap);
    expect(
      t.service.latestLeaseCap(t.seconds() + LIFECYCLE.leaseSeconds + 1),
    ).toBeUndefined();
    await t.service.releaseSessionLease(reservation);
    expect(t.service.latestLeaseCap(t.seconds())).toBeUndefined();
  });
});
