/** @jest-environment node */
import { expect, jest, test } from "@jest/globals";
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));

import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  INSTANCE,
  NOW_MS,
  START_MS,
  button,
  meetingFor,
  never,
  reservationFor,
  setup,
  useSilencedCloseLogs,
} from "./meetingClose.fixture";

useSilencedCloseLogs();

test("a normal close leaves voice, restores the nickname, writes processing with a claim, releases the lease and starts the local finish, in that order", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, button);

  expect(t.calls).toEqual([
    "confirm",
    "stop:complete",
    "leave",
    "nickname",
    "flush",
    "record",
    "retire",
    "release",
    "drop",
    "unprotect",
    "prepare",
    "finish",
  ]);
  const [input] = t.recorded();
  expect(input.reservation).toBe(meeting.reservation);
  expect(input.patch).toEqual({
    capture: expect.objectContaining({ kind: "complete" }),
    endReason: "button",
    endTriggeredByUserId: "u-1",
    duration: (NOW_MS - START_MS) / 1000,
  });
  expect(input.claimOwner).toMatch(new RegExp(`^${INSTANCE}:[0-9a-f-]{36}$`));
  expect(input.now).toBe(NOW_MS / 1000);
  expect(t.starter).toHaveBeenCalledWith(meeting, input.claimOwner);
  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(meeting.finishing).toBe(true);
});

test("step 4 is retried", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.finish.recordCaptureEnd
    .mockRejectedValueOnce(new Error("synthetic outage"))
    .mockRejectedValueOnce(new Error("synthetic outage"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(
    LIFECYCLE.closeWriteAttempts,
  );
  const owners = t.recorded().map((input) => input.claimOwner);
  expect(new Set(owners).size).toBe(1);
  expect(t.starter).toHaveBeenCalledTimes(1);
});

test("step 4 that never succeeds still frees the server and starts no local finish", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.finish.recordCaptureEnd.mockRejectedValue(new Error("synthetic"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(
    LIFECYCLE.closeWriteAttempts,
  );
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.starter).not.toHaveBeenCalled();
});

test("lease is released when step 3 throws", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.flushCapture.mockRejectedValueOnce(new Error("synthetic flush"));

  await expect(t.close.closeMeeting(meeting, button)).resolves.toBeUndefined();

  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledWith(
    meeting.reservation,
  );
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("a release that throws still drops the meeting and releases protection", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.releaseSessionLease.mockRejectedValueOnce(new Error("unknown"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("draining worker writes no claim", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.isEligible.mockReturnValue(false);

  await t.close.closeMeeting(meeting, button);

  expect(t.recorded()[0].claimOwner).toBeUndefined();
  expect(t.recorded()[0].patch.capture?.kind).toBe("complete");
  expect(t.starter).not.toHaveBeenCalled();
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("lost lease sends no leave and writes interrupted", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockResolvedValueOnce("lost");

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).not.toHaveBeenCalled();
  expect(t.deps.dropVoiceLocally).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.restoreNickname).not.toHaveBeenCalled();
  expect(t.deps.flushCapture).not.toHaveBeenCalled();
  const [input] = t.recorded();
  expect(input.claimOwner).toBeUndefined();
  expect(input.patch.capture?.kind).toBe("interrupted");
  expect(input.patch.endReason).toBe("unknown");
  expect(input.patch.endTriggeredByUserId).toBeUndefined();
  expect(t.deps.lease.releaseSessionLease).not.toHaveBeenCalled();
  expect(t.deps.dropMeeting).toHaveBeenCalledWith(meeting);
  expect(t.starter).not.toHaveBeenCalled();
});

test("an abnormal cause or an already interrupted capture writes interrupted", async () => {
  const abnormal = meetingFor("synthetic-meeting-a");
  const failed = meetingFor("synthetic-meeting-b");
  failed.recordingCaptureState = {
    kind: "interrupted",
    startedAt: null,
    endedAt: null,
    detectedAt: new Date(NOW_MS).toISOString(),
  };
  const t = setup([abnormal, failed]);

  await t.close.closeMeeting(abnormal, {
    endReason: "unknown",
    abnormal: true,
  });
  await t.close.closeMeeting(failed, button);

  expect(t.recorded().map((input) => input.patch.capture?.kind)).toEqual([
    "interrupted",
    "interrupted",
  ]);
  expect(t.deps.leaveVoice).toHaveBeenCalledTimes(2);
});

test("concurrent closes share one promise and write the capture end once", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  const first = t.close.closeMeeting(meeting, button);
  const second = t.close.closeMeeting(meeting, {
    endReason: "channel_empty",
  });
  expect(second).toBe(first);
  await Promise.all([first, second]);

  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.recorded()[0].patch.endReason).toBe("button");
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a capture that reached its lease cap closes normally with a leave", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockResolvedValueOnce("capped");

  await t.close.closeMeeting(meeting, { endReason: "timeout" });

  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.dropVoiceLocally).not.toHaveBeenCalled();
  expect(t.recorded()[0].patch).toMatchObject({
    capture: { kind: "complete" },
    endReason: "timeout",
  });
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a confirmation error before this worker's lease ran out closes normally", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockRejectedValueOnce(new Error("outage"));

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("protection is released only when the last capture closes", async () => {
  const first = meetingFor("synthetic-meeting-a");
  const second = meetingFor("synthetic-meeting-b");
  const t = setup([first, second]);
  t.setCap(NOW_MS / 1000 + 600);

  await t.close.closeMeeting(first, button);
  expect(t.deps.releaseCaptureProtection).not.toHaveBeenCalled();

  t.setCap(undefined);
  await t.close.closeMeeting(second, button);
  expect(t.deps.releaseCaptureProtection).toHaveBeenCalledTimes(1);
});

test("close refuses a meeting the new lease service does not hold and changes nothing", async () => {
  const legacy = meetingFor();
  const ending = meetingFor("synthetic-meeting-b");
  ending.finishing = true;
  const t = setup([legacy, ending]);
  t.deps.lease.holdsSessionLease.mockImplementation(
    (reservation) => reservation.meetingId !== legacy.meetingId,
  );

  await t.close.closeMeeting(legacy, button);
  await t.close.closeMeeting(ending, button);

  expect(t.calls).toEqual([]);
  expect(legacy.finishing).toBe(false);
  expect(legacy.endReason).toBeUndefined();
  expect(t.deps.liveMeetings()).toEqual([legacy, ending]);
});

test("a nickname restore that never resolves does not delay the lease release beyond its bound", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.restoreNickname.mockImplementationOnce(() => never());
  t.deps.sleep.mockImplementation((ms: number) =>
    ms === LIFECYCLE.closeNicknameMs ? Promise.resolve() : never(),
  );

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.sleep).toHaveBeenCalledWith(
    LIFECYCLE.closeNicknameMs,
    expect.any(AbortSignal),
  );
  expect(t.deps.flushCapture).toHaveBeenCalledTimes(1);
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("a step-2 failure does not skip the steps after it", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.stopCapture.mockImplementationOnce(() => {
    throw new Error("synthetic stop");
  });
  t.deps.leaveVoice.mockImplementationOnce(() => {
    throw new Error("synthetic leave");
  });

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).toHaveBeenCalledWith(meeting.connection);
  expect(t.calls).toEqual([
    "confirm",
    "nickname",
    "flush",
    "record",
    "retire",
    "release",
    "drop",
    "unprotect",
    "prepare",
    "finish",
  ]);
});

test("a confirmation error after this worker's lease ran out drops voice locally", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockRejectedValueOnce(new Error("outage"));
  t.deps.lease.confirmedLeaseExpiry.mockReturnValue(NOW_MS / 1000 - 1);

  await t.close.closeMeeting(meeting, button);

  expect(t.deps.leaveVoice).not.toHaveBeenCalled();
  expect(t.deps.dropVoiceLocally).toHaveBeenCalledWith(meeting.connection);
  expect(t.deps.lease.releaseSessionLease).toHaveBeenCalledTimes(1);
});

test("lease loss and the cap close the live meeting", async () => {
  const lost = meetingFor("synthetic-meeting-a");
  const capped = meetingFor("synthetic-meeting-b");
  const t = setup([lost, capped]);

  t.close.captureEndHandlers.onLost({
    reservation: reservationFor("synthetic-meeting-a"),
    meeting: lost,
  });
  t.close.captureEndHandlers.onCapReached({
    reservation: reservationFor("synthetic-meeting-b"),
    meeting: capped,
  });
  t.close.captureEndHandlers.onLost({
    reservation: reservationFor("synthetic-meeting-c"),
  });
  await Promise.all([
    t.close.closeMeeting(lost, button),
    t.close.closeMeeting(capped, button),
  ]);

  expect(t.recorded().map((input) => input.patch.endReason)).toEqual([
    "unknown",
    "timeout",
  ]);
  expect(t.recorded()[0].patch.capture?.kind).toBe("interrupted");
  expect(t.recorded()[1].patch.capture?.kind).toBe("complete");
});

test("a normal close leaves the capture signal live", async () => {
  const meeting = meetingFor();
  const ownership = new AbortController();
  meeting.ownershipSignal = ownership.signal;
  const t = setup([meeting]);

  await t.close.closeMeeting(meeting, button);

  expect(meeting.ownershipSignal.aborted).toBe(false);
});

test("stop pressed twice, or racing an emptied channel, closes once", async () => {
  const meeting = meetingFor();
  const t = setup([meeting]);

  const first = t.close.closeMeeting(meeting, button);
  const second = t.close.closeMeeting(meeting, { endReason: "channel_empty" });

  expect(second).toBe(first);
  await first;
  expect(t.deps.finish.recordCaptureEnd).toHaveBeenCalledTimes(1);
  expect(t.recorded()[0].patch).toMatchObject({
    endReason: "button",
    endTriggeredByUserId: "u-1",
  });
});

test("close marks the meeting finishing before its first await", () => {
  const meeting = meetingFor();
  const t = setup([meeting]);
  t.deps.lease.confirmSessionLease.mockImplementationOnce(() => never());

  void t.close.closeMeeting(meeting, button);

  expect(meeting.finishing).toBe(true);
});
