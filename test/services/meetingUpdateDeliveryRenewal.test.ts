/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  runDelivery as run,
  initializeDeliveryClock,
  settleDeliveryWorks,
  getRuntimeWorkAdmissionCheckpoints,
} from "./meetingUpdateDelivery.harness";
import {
  deliveryFixture,
  deferred,
  holdPatch,
  interceptRenewal,
} from "./meetingUpdateDelivery.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { now } from "../types/meetingUpdateDelivery.fixture";
import { context } from "../deployment/controlFixtures";
beforeEach(initializeDeliveryClock);
afterEach(settleDeliveryWorks);
async function heldDelivery() {
  const f = deliveryFixture();
  const { entered, tail } = holdPatch(f);
  const invocation = run(f, false, 10000, { renewalIntervalMs: 5 });
  await entered.promise;
  const plan = planMeetingUpdate(f.input);
  if (plan.kind !== "ready") throw new Error("Expected plan");
  return { f, tail, invocation, after: plan.targets[0].after };
}
test("an existing delivery owner renews and completes when ordinary admission enters maintenance", async () => {
  const h = await heldDelivery();
  const renewed = deferred<void>();
  const lifecycle = jest.requireMock<
    typeof import("../../src/services/runtimeLifecycleService")
  >("../../src/services/runtimeLifecycleService");
  jest
    .spyOn(lifecycle, "getRuntimeAdmissionContext")
    .mockImplementation(async () => ({
      ...context,
      now: Math.floor(Date.now() / 1000),
      maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
    }));
  const record = h.invocation.work.recordClaim.bind(h.invocation.work);
  jest.spyOn(h.invocation.work, "recordClaim").mockImplementation((claim) => {
    record(claim);
    if (claim.expiresAt > now + 60) renewed.resolve();
  });
  jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
  try {
    await renewed.promise;
  } finally {
    h.f.remote.set(h.after.id, h.after);
    h.tail.resolve(Response.json(h.after));
  }
  expect((await h.invocation.promise).kind).toBe("settled");
  expect((await h.f.read()).updateDelivery.progress.kind).toBe("synced");
});
test.each([true, false])(
  "renewal ACK loss committed%s has exact readback or unresolved outcome",
  async (committed) => {
    const h = await heldDelivery();
    const seen = deferred<void>();
    const confirmed = deferred<void>();
    const record = h.invocation.work.recordClaim.bind(h.invocation.work);
    jest.spyOn(h.invocation.work, "recordClaim").mockImplementation((claim) => {
      record(claim);
      if (claim.expiresAt > now + 60) confirmed.resolve();
    });
    interceptRenewal(h.f.repository, async (proceed) => {
      if (committed) await proceed();
      seen.resolve();
      throw new Error("Renewal ACK unknown");
    });
    jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
    await seen.promise;
    if (committed) await confirmed.promise;
    else await new Promise((resolve) => setImmediate(resolve));
    h.f.remote.set(h.after.id, h.after);
    h.tail.resolve(Response.json(h.after));
    const result = await h.invocation.promise;
    expect(result.kind).toBe(committed ? "settled" : "uncertain");
    if (committed) expect(result.durable?.claim?.expiresAt).toBe(now + 80);
    else expect(result.durable).toBeUndefined();
  },
);
test("a fenced pending renewal and held provider response remain owned until both actual tails settle", async () => {
  const h = await heldDelivery();
  const entered = deferred<void>();
  const renewalTail = deferred<void>();
  interceptRenewal(h.f.repository, async (proceed) => {
    entered.resolve();
    await renewalTail.promise;
    return proceed();
  });
  jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
  await entered.promise;
  h.invocation.work.fence();
  const checkpoint = getRuntimeWorkAdmissionCheckpoints().find(
    (item) => item.signal === h.invocation.work.signal,
  )!;
  const effects = checkpoint.effects.length;
  h.f.remote.set(h.after.id, h.after);
  h.tail.resolve(Response.json(h.after));
  await new Promise((resolve) => setImmediate(resolve));
  expect(
    getRuntimeWorkAdmissionCheckpoints().find(
      (item) => item.id === checkpoint.id,
    )?.effects.length,
  ).toBeGreaterThan(0);
  renewalTail.resolve();
  await h.invocation.promise;
  expect(effects).toBeGreaterThanOrEqual(2);
});
