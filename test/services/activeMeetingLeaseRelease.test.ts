/** @jest-environment node */
jest.mock("../../src/db", () => ({ releaseActiveMeetingLease: jest.fn() }));
import { releaseActiveMeetingLease } from "../../src/db";
import { releaseOriginalLease } from "../../src/services/activeMeetingLeaseRelease";
import type { SessionReservation } from "../../src/types/deploymentControl";
import { leaseDeleteResponse } from "../fixtures/leaseDeleteResponse";

function fixture() {
  const reservation: SessionReservation = {
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "owner",
    executionVersion: 1,
    voiceOperationAttemptId: "voice",
    sessionMode: "tts_only",
    reservedAt: 1,
    workHandle: { settle: jest.fn(), transition: jest.fn() },
  };
  const owned: { reservation: SessionReservation; release?: Promise<boolean> } =
    {
      reservation,
    };
  const controller = new AbortController();
  const onReleaseSettled = jest.fn();
  const proof = {
    signal: controller.signal,
    deadline: Date.now() + 30000,
    onReleaseSettled,
  };
  const server = Promise.withResolvers<boolean>();
  jest
    .mocked(releaseActiveMeetingLease)
    .mockImplementation((...args) =>
      leaseDeleteResponse(server.promise, args[4]),
    );
  return { owned, controller, proof, server, onReleaseSettled };
}
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

test("absolute deadline before queued dispatch submits no delete without abort", async () => {
  const f = fixture();
  const release = releaseOriginalLease(f.owned, f.proof);
  jest.spyOn(Date, "now").mockReturnValue(f.proof.deadline);
  f.server.resolve(true);
  await release;
  expect(f.controller.signal.aborted).toBe(false);
  expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
  expect(f.onReleaseSettled).not.toHaveBeenCalled();
  expect(f.owned.release).toBeUndefined();
});

test.each([
  ["success", 0],
  ["rejection", 0],
  ["success", -1],
  ["rejection", -1],
] as const)(
  "actual %s at deadline offset %i signals progress without abort",
  async (outcome, offset) => {
    const f = fixture();
    const release = releaseOriginalLease(f.owned, f.proof);
    await Promise.resolve();
    expect(releaseActiveMeetingLease).toHaveBeenCalledTimes(1);
    jest.spyOn(Date, "now").mockReturnValue(f.proof.deadline + offset);
    expect(f.onReleaseSettled).not.toHaveBeenCalled();
    if (outcome === "success") f.server.resolve(true);
    else f.server.reject(new Error("response unknown"));
    await release;
    expect(f.controller.signal.aborted).toBe(false);
    expect(f.onReleaseSettled).toHaveBeenCalledTimes(1);
    expect(f.owned.release).toBeDefined();
    expect(releaseActiveMeetingLease).toHaveBeenCalledTimes(1);
  },
);

test("expiry before queued dispatch submits no delete or completion event", async () => {
  const f = fixture();
  const release = releaseOriginalLease(f.owned, f.proof);
  f.controller.abort(new Error("budget expired"));
  await expect(release).rejects.toThrow("budget expired");
  expect(releaseActiveMeetingLease).not.toHaveBeenCalled();
  expect(f.onReleaseSettled).not.toHaveBeenCalled();
  expect(f.owned.release).toBeUndefined();
});

test("expiry after dispatch retains the real SDK response until actual completion", async () => {
  const f = fixture();
  let finished = false;
  const release = releaseOriginalLease(f.owned, f.proof).finally(() => {
    finished = true;
  });
  void release.catch(() => {});
  await Promise.resolve();
  expect(releaseActiveMeetingLease).toHaveBeenCalledTimes(1);
  f.controller.abort(new Error("budget expired"));
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.onReleaseSettled).not.toHaveBeenCalled();
  f.server.resolve(true);
  await release;
  expect(await f.owned.release).toBe(true);
  expect(f.onReleaseSettled).toHaveBeenCalledTimes(1);
});
