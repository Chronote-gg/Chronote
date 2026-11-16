/** @jest-environment node */
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  abandonedCaptureEnd,
  captureEndFromManifest,
  classifyFinisherRow,
  type FinisherAction,
} from "../../src/services/meetingFinisher";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import {
  BRIEF_LAPSE_SECONDS,
  GRACE,
  LATE_MS,
  NOW,
  SAVED_MINUTES,
  SECONDS_PER_MINUTE,
  START,
  START_MS,
  START_SECONDS,
  at,
  finisherRow,
  isoAt,
  lease,
  manifestWith,
  piece,
  row,
  verifiedUntil,
} from "./meetingFinisher.fixture";

describe("classifyFinisherRow", () => {
  const live = (status: "starting" | "in_progress", sinceSeconds: number) =>
    row("a", { status, updatedAt: isoAt(NOW - sinceSeconds) });
  const cases: Array<
    [string, MeetingHistory, ActiveMeetingLease | undefined, FinisherAction]
  > = [
    [
      "a live lease naming the same meeting",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW + 1),
      "skip",
    ],
    [
      "a live lease naming a different meeting",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-next", NOW + 1),
      "adopt",
    ],
    [
      "lease naming this meeting expired 30 seconds ago",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW - BRIEF_LAPSE_SECONDS),
      "skip",
    ],
    [
      "lease naming this meeting expired longer than the grace ago",
      live("in_progress", GRACE + 1),
      lease("synthetic-meeting-a", NOW - GRACE - 1),
      "adopt",
    ],
    [
      "a starting row whose lease lapsed briefly",
      live("starting", GRACE + 1),
      lease("synthetic-meeting-a", NOW - BRIEF_LAPSE_SECONDS),
      "skip",
    ],
    [
      "a claim that is held and unexpired",
      row("a", {
        finish: { owner: "w", expiresAt: NOW, attempts: 0, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "a claim whose holder stopped renewing",
      row("a", {
        finish: {
          owner: "w",
          expiresAt: NOW - 1,
          attempts: 0,
          phase: "process",
        },
      }),
      undefined,
      "claim",
    ],
    [
      "a retry whose time has not arrived",
      row("a", {
        finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "a retry whose time has arrived",
      row("a", {
        finish: { attempts: 1, nextAttemptAt: NOW, phase: "process" },
      }),
      undefined,
      "claim",
    ],
    ["starting inside the grace", live("starting", GRACE), undefined, "skip"],
    [
      "starting past the grace",
      live("starting", GRACE + 1),
      undefined,
      "adopt",
    ],
    [
      "in progress inside the grace",
      live("in_progress", GRACE),
      undefined,
      "skip",
    ],
    [
      "in progress past the grace",
      live("in_progress", GRACE + 1),
      undefined,
      "adopt",
    ],
    [
      "in progress with no checkpoint, timed from its start",
      row("a", { status: "in_progress", timestamp: isoAt(NOW - GRACE - 1) }),
      undefined,
      "adopt",
    ],
    ["processing and unclaimed", row("a"), undefined, "claim"],
    [
      "terminal with a delivery marker",
      row("a", {
        status: "complete",
        finish: { attempts: 1, phase: "deliver", deliverSince: NOW - 60 },
      }),
      undefined,
      "claim",
    ],
    [
      "terminal with a delivery retry not yet due",
      row("a", {
        status: "complete",
        finish: { attempts: 1, nextAttemptAt: NOW + 1, phase: "deliver" },
      }),
      undefined,
      "skip",
    ],
    [
      "non-terminal past 24 hours",
      row("a", { timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1) }),
      undefined,
      "abandon",
    ],
    [
      "non-terminal past 24 hours with a retry not yet due",
      row("a", {
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { attempts: 2, nextAttemptAt: NOW + 1, phase: "process" },
      }),
      undefined,
      "abandon",
    ],
    [
      "non-terminal past 24 hours with a claim still held",
      row("a", {
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { owner: "w", expiresAt: NOW, attempts: 0, phase: "process" },
      }),
      undefined,
      "skip",
    ],
    [
      "terminal with a delivery marker past 24 hours",
      row("a", {
        status: "complete",
        timestamp: isoAt(NOW - LIFECYCLE.abandonSeconds - 1),
        finish: { attempts: 3, phase: "deliver", deliverSince: NOW - 60 },
      }),
      undefined,
      "claim",
    ],
  ];

  it.each(cases)("%s", (_label, history, currentLease, action) => {
    expect(classifyFinisherRow(finisherRow(history), currentLease, NOW)).toBe(
      action,
    );
  });
});

describe("captureEndFromManifest", () => {
  test("exact coverage wins over any estimate", () => {
    const manifest = {
      ...verifiedUntil(START_SECONDS + SAVED_MINUTES * SECONDS_PER_MINUTE),
      audio: [piece(50_000_000, 50_000_000)],
    };
    expect(captureEndFromManifest(manifest, isoAt(NOW), LATE_MS)).toEqual({
      confirmedAt: isoAt(START_SECONDS + SAVED_MINUTES * SECONDS_PER_MINUTE),
    });
  });

  test("a piece's last arrival is preferred over its intervals, and the latest piece counts", () => {
    expect(
      captureEndFromManifest(
        manifestWith(piece(5_000, 8_000), piece(6_000, 6_500)),
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: at(6_000) });
  });

  test("a piece without timing is estimated from its intervals", () => {
    expect(
      captureEndFromManifest(
        manifestWith(piece(undefined, 8_000), piece(5_000, 5_000)),
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: at(8_000) });
  });

  test("the estimate is no later than the row's last write or now, and no earlier than the capture start", () => {
    const manifest = manifestWith(piece(9_000, 9_000));
    expect(captureEndFromManifest(manifest, at(4_000), LATE_MS)).toEqual({
      estimatedAt: at(4_000),
    });
    expect(
      captureEndFromManifest(manifest, isoAt(NOW), START_MS + 3_000),
    ).toEqual({ estimatedAt: at(3_000) });
    expect(
      captureEndFromManifest(
        manifestWith(piece(-500, 20)),
        at(-1_000),
        LATE_MS,
      ),
    ).toEqual({ estimatedAt: START });
  });

  test("no audio pieces, or no capture start, gives no end", () => {
    expect(captureEndFromManifest(manifestWith(), isoAt(NOW), LATE_MS)).toEqual(
      {},
    );
    expect(
      captureEndFromManifest(
        { ...manifestWith(piece(5_000, 5_000)), captureStartedAt: null },
        isoAt(NOW),
        LATE_MS,
      ),
    ).toEqual({});
  });

  test("an estimate sets the duration only: the end time stays unknown", () => {
    const end = abandonedCaptureEnd(
      row("a", { capture: { kind: "capturing", startedAt: START } }),
      { estimatedAt: at(90_000) },
      NOW,
    );
    expect(end).toEqual({
      capture: {
        kind: "interrupted",
        startedAt: START,
        detectedAt: isoAt(NOW),
        endedAt: null,
      },
      endReason: "unknown",
      duration: 90,
    });
    expect(abandonedCaptureEnd(row("a"), {}, NOW).duration).toBe(0);
  });
});
