/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
  releaseAcknowledgedRuntimeWork,
} from "../../src/services/runtimeWorkAdmissionService";
import { deferred } from "./meetingUpdateDelivery.fixture";

const claim = {
  claimId: "synthetic-attempt",
  instanceId: "owner",
  expiresAt: 160,
};
let sequence = 0;
function begin() {
  return beginRuntimeWorkClaim(
    "meeting_update_delivery",
    `delivery-lifetime-${++sequence}`,
  );
}
function checkpoint(work: ReturnType<typeof begin>) {
  return getRuntimeWorkAdmissionCheckpoints().find(
    (c) => c.signal === work.signal,
  );
}

test("unfenced completed promise stays owned until explicit positive no-claim proof", async () => {
  const work = begin();
  await work.trackPromise(async () => {});
  await work.settle();
  expect(checkpoint(work)).toBeDefined();
  expect(work.acknowledgeMeetingUpdateDelivery({})).toBe(false);
  expect(
    work.acknowledgeMeetingUpdateDelivery({
      noClaim: { kind: "never_admitted" },
    }),
  ).toBe(true);
  expect(checkpoint(work)).toBeUndefined();
});
test("no-claim acknowledgment cannot outrun the actual owned promise or effect tail", async () => {
  const work = begin(),
    tail = deferred<void>();
  const actual = work.trackPromise(() => work.trackEffect(() => tail.promise));
  work.fence();
  const settlement = work.settle();
  expect(
    work.acknowledgeMeetingUpdateDelivery({
      noClaim: { kind: "never_admitted" },
    }),
  ).toBe(false);
  expect(checkpoint(work)?.effects).toHaveLength(1);
  tail.resolve();
  await actual;
  await settlement;
  expect(
    work.acknowledgeMeetingUpdateDelivery({
      noClaim: { kind: "never_admitted" },
    }),
  ).toBe(true);
});
test.each(["claimId", "instanceId", "expiresAt", "attempt"] as const)(
  "handoff rejects a mismatched %s",
  async (field) => {
    const work = begin();
    work.recordClaim(claim);
    work.claimed();
    await work.trackPromise(async () => {});
    work.fence();
    await work.settle();
    const wrong = {
      ...claim,
      [field]: field === "expiresAt" || field === "attempt" ? 2 : "other",
    };
    expect(
      work.acknowledgeMeetingUpdateDelivery({
        durable: { deliveryRevision: "known", claim: wrong },
      }),
    ).toBe(false);
    expect(
      work.acknowledgeMeetingUpdateDelivery({
        noClaim: { kind: "never_admitted" },
      }),
    ).toBe(false);
    expect(
      work.acknowledgeMeetingUpdateDelivery({
        durable: { deliveryRevision: "known", claim },
      }),
    ).toBe(true);
  },
);
test("unknown acknowledgment remains counted after all local promises settle", async () => {
  const work = begin();
  work.recordClaim(claim);
  await work.trackPromise(async () => {});
  work.fence();
  await work.settle();
  expect(work.acknowledgeMeetingUpdateDelivery({})).toBe(false);
  expect(releaseAcknowledgedRuntimeWork(checkpoint(work)!.id)).toBe(false);
  expect(checkpoint(work)).toBeDefined();
  expect(
    work.acknowledgeMeetingUpdateDelivery({
      durable: { deliveryRevision: "read-back", claim },
    }),
  ).toBe(true);
});
test("strongly proved unclaimed transition releases, other domains cannot borrow it", async () => {
  const work = begin();
  await work.trackPromise(async () => {});
  work.fence();
  await work.settle();
  expect(
    work.acknowledgeMeetingUpdateDelivery({
      durable: { deliveryRevision: "blocked", claim: null },
    }),
  ).toBe(true);
  const other = beginRuntimeWorkClaim("recovery", "synthetic-other-domain");
  await other.trackPromise(async () => {});
  other.fence();
  await other.settle();
  expect(
    other.acknowledgeMeetingUpdateDelivery({
      noClaim: { kind: "never_admitted" },
    }),
  ).toBe(false);
  other.acknowledgeReadOnlyRecoveryPoll();
  expect(releaseAcknowledgedRuntimeWork("synthetic-other-domain")).toBe(true);
});
