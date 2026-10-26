/** @jest-environment node */
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
  fenceAndSettleSessionWork,
  releaseAcknowledgedRuntimeWork,
} from "../../src/services/runtimeWorkAdmissionService";
const mockReservations: Array<{
  reservation: import("../../src/types/deploymentControl").SessionReservation;
}> = [];
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => mockReservations,
  getReservationSignal: () => new AbortController().signal,
  isReservationControlEligible: () => true,
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: () => ({ settle: jest.fn(), transition: jest.fn() }),
}));

test("settlement seals new effects and retains an already-issued full chain", async () => {
  const work = beginRuntimeWorkClaim("personal", "synthetic-lifetime");
  let complete!: () => void;
  const task = work.trackEffect(
    () =>
      new Promise<void>((done) => {
        complete = done;
      }),
  );
  const settled = work.settle();
  const late = jest.fn(async () => {});
  await expect(work.trackEffect(late)).rejects.toThrow();
  expect(late).not.toHaveBeenCalled();
  expect(getRuntimeWorkAdmissionCheckpoints()[0].localSettled).toBe(false);
  complete();
  await task;
  await settled;
  expect(getRuntimeWorkAdmissionCheckpoints()).toHaveLength(0);
});

test.each([true, false])(
  "session fence waits actual child effect and releases only exact terminal ACK: %s",
  async (terminalAck) => {
    const owner = {
      guildId: `synthetic-${terminalAck}`,
      meetingId: "meeting",
      ownerInstanceId: "owner",
      executionVersion: 1,
      voiceOperationAttemptId: "voice",
      sessionMode: "meeting",
      workHandle: { beginOwnedControl: () => ({ settle: jest.fn() }) },
    } as unknown as import("../../src/types/deploymentControl").SessionReservation;
    const other = {
      ...owner,
      guildId: `other-${terminalAck}`,
      meetingId: "other",
      voiceOperationAttemptId: "other-voice",
    };
    mockReservations.push({ reservation: owner }, { reservation: other });
    const child = beginRuntimeWorkClaim(
      "control",
      `child-${terminalAck}`,
      owner,
    );
    const unrelated = beginRuntimeWorkClaim(
      "interaction",
      `other-${terminalAck}`,
      other,
    );
    child.recordClaim({
      claimId: "original",
      instanceId: "owner",
      attempt: 1,
      expiresAt: 100,
    });
    let release!: () => void;
    const effect = child.trackEffect(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const actual = child.trackPromise(async () => {
      await effect;
      if (terminalAck) child.acknowledgeTerminal();
      await child.settle();
    });
    let settled = false;
    const drain = fenceAndSettleSessionWork(owner).then((value) => {
      settled = true;
      return value;
    });
    expect(child.signal.aborted).toBe(true);
    expect(unrelated.signal.aborted).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    await unrelated.trackEffect(async () => {});
    await unrelated.settle();
    release();
    await actual;
    expect(await drain).toBe(terminalAck);
    expect(
      getRuntimeWorkAdmissionCheckpoints().some(
        ({ id }) => id === `child-${terminalAck}`,
      ),
    ).toBe(!terminalAck);
  },
);

test.each(["known", "unknown", "cancelled"] as const)(
  "personal terminal ACK cannot certify later ancillary delivery: %s",
  async (outcome) => {
    const id = `synthetic-delivery-${outcome}`;
    const work = beginRuntimeWorkClaim("personal", id);
    const claim = {
      claimId: id,
      instanceId: "synthetic",
      attempt: 1,
      expiresAt: 100,
    };
    work.recordClaim(claim);
    await work.trackPromise(async () => {
      work.acknowledgeTerminal();
      work.delivering();
      // Unknown post-claim mutation fences itself even without external shutdown.
      if (outcome !== "known") work.fence();
      await work.settle();
    });
    expect(releaseAcknowledgedRuntimeWork(id)).toBe(outcome === "known");
    const checkpoint = getRuntimeWorkAdmissionCheckpoints().find(
      (entry) => entry.id === id,
    );
    if (outcome === "known") expect(checkpoint).toBeUndefined();
    else
      expect(checkpoint).toMatchObject({
        domain: "ancillary",
        localSettled: true,
        terminalAcknowledged: claim,
      });
  },
);

test("billing writes require durable-cycle acknowledgment after fencing, never a read-only poll acknowledgment", async () => {
  const key = "RENEWAL_RECOVERY#synthetic#sub#100";
  const work = beginRuntimeWorkClaim("billing", key);
  await work.trackPromise(async () => {
    await work.trackBillingMutation(async () => undefined);
    work.fence();
    work.acknowledgeReadOnlyRecoveryPoll();
    await work.settle();
  });
  expect(releaseAcknowledgedRuntimeWork(key)).toBe(false);
  expect(() =>
    work.acknowledgeDurableBillingRecovery("another-cycle"),
  ).toThrow();
  work.acknowledgeDurableBillingRecovery(key);
  expect(releaseAcknowledgedRuntimeWork(key)).toBe(true);
});
