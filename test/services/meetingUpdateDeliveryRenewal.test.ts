/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
import {
  runDelivery as run,
  initializeDeliveryClock,
  settleDeliveryWorks,
} from "./meetingUpdateDelivery.harness";
import {
  deliveryFixture,
  deferred,
  holdPatch,
  interceptRenewal,
} from "./meetingUpdateDelivery.fixture";
import { planMeetingUpdate } from "../../src/services/meetingUpdatePlan";
import { now } from "../types/meetingUpdateDelivery.fixture";
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
const flush = () => new Promise((resolve) => setImmediate(resolve));
test("an existing delivery owner renews and completes", async () => {
  const h = await heldDelivery();
  const renewed = deferred<void>();
  interceptRenewal(h.f.repository, async (proceed) => {
    const result = await proceed();
    renewed.resolve();
    return result;
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
    interceptRenewal(h.f.repository, async (proceed) => {
      if (committed) await proceed();
      seen.resolve();
      throw new Error("Renewal ACK unknown");
    });
    jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
    await seen.promise;
    await flush();
    h.f.remote.set(h.after.id, h.after);
    h.tail.resolve(Response.json(h.after));
    const result = await h.invocation.promise;
    expect(result.kind).toBe(committed ? "settled" : "uncertain");
  },
);
test("a lost lease renewal lets the in-flight request finish and starts nothing later", async () => {
  const f = deliveryFixture();
  const entered = deferred<void>();
  const tail = deferred<Response>();
  // Unlike holdPatch, this request fails the moment its signal aborts.
  f.intercept(async (method) => {
    if (method !== "PATCH") return undefined;
    const signal = f.signals.at(-1);
    entered.resolve();
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason));
      void tail.promise.then(resolve);
    });
  });
  const invocation = run(f, false, 10000, { renewalIntervalMs: 5 });
  await entered.promise;
  const plan = planMeetingUpdate(f.input);
  if (plan.kind !== "ready") throw new Error("Expected plan");
  const after = plan.targets[0].after;
  const lost = deferred<void>();
  interceptRenewal(f.repository, async () => {
    lost.resolve();
    return "stale";
  });
  jest.spyOn(Date, "now").mockReturnValue((now + 20) * 1000);
  await lost.promise;
  await flush();
  expect(f.signals.at(-1)?.aborted).toBe(false);
  const calls = f.calls.length;
  f.remote.set(after.id, after);
  tail.resolve(Response.json(after));
  expect((await invocation.promise).kind).toBe("uncertain");
  expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual(
    [],
  );
  // The claim itself was never lost, so the claim-conditioned completion lands; nothing is left uncertain.
  expect((await f.read()).updateDelivery.progress.kind).toBe("synced");
});
test("a stopped pending renewal and held provider response both settle before the run ends", async () => {
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
  h.invocation.controller.abort();
  let settled = false;
  void h.invocation.promise.then(() => {
    settled = true;
  });
  h.f.remote.set(h.after.id, h.after);
  h.tail.resolve(Response.json(h.after));
  await flush();
  expect(settled).toBe(false);
  renewalTail.resolve();
  await h.invocation.promise;
  expect(settled).toBe(true);
});
