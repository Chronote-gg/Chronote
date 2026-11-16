/** @jest-environment node */
jest.mock("openai", () => {
  throw new Error("Discord delivery imported OpenAI");
});
import { withDelivery } from "../../src/repositories/meetingUpdateDeliveryState";
import { createMeetingUpdateDeliveryWorker } from "../../src/services/meetingUpdateDeliveryWorkerService";
import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { deliveryFixture, deferred } from "./meetingUpdateDelivery.fixture";
import { now } from "../types/meetingUpdateDelivery.fixture";

function deliveryWorker(f: ReturnType<typeof deliveryFixture>) {
  const service = createMeetingUpdateDeliveryService({
    repository: f.repository,
    discord: createDiscordMeetingUpdateTransport({
      token: "synthetic",
      fetchImpl: f.fetchImpl,
    }),
    now: () => now,
  });
  return createMeetingUpdateDeliveryWorker({
    repository: f.repository,
    deliver: service.deliverMeetingUpdate,
    reconcile: service.reconcileMeetingUpdate,
    now: () => now,
    isEligible: () => true,
  });
}
function queuedFixture() {
  const f = deliveryFixture();
  f.setRow(withDelivery(f.input.history, f.input.history.updateDelivery));
  return f;
}
const mutations = (f: ReturnType<typeof deliveryFixture>) =>
  f.requests.map(({ method, id }) => `${method} ${id}`);
async function untilSynced(f: ReturnType<typeof deliveryFixture>) {
  for (let turn = 0; turn < 200; turn++) {
    if ((await f.read()).updateDelivery.progress.kind === "synced") return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Delivery never synced");
}
beforeEach(() => jest.spyOn(Date, "now").mockReturnValue(now * 1000));
afterEach(() => jest.restoreAllMocks());

test("the worker loop delivers with no deployment control record present", async () => {
  const f = queuedFixture();
  const worker = deliveryWorker(f);
  try {
    await worker.poll();
    await untilSynced(f);
    expect(mutations(f).length).toBeGreaterThan(0);
  } finally {
    await worker.stop();
  }
});

test("two workers claim the same delivery: exactly one delivers", async () => {
  const solo = queuedFixture();
  const alone = deliveryWorker(solo);
  await alone.poll();
  await untilSynced(solo);
  await alone.stop();

  const f = queuedFixture();
  const claim = f.repository.claim.bind(f.repository);
  const claims: string[] = [];
  jest.spyOn(f.repository, "claim").mockImplementation(async (input) => {
    const result = await claim(input);
    claims.push(result);
    return result;
  });
  const first = deliveryWorker(f);
  const second = deliveryWorker(f);
  try {
    await Promise.all([first.poll(), second.poll()]);
    await untilSynced(f);
    await Promise.all([first.stop(), second.stop()]);
    // Both workers planned and raced the claim write; its own condition picked one.
    expect(claims.sort()).toEqual(["claimed", "stale"]);
    expect(mutations(f)).toEqual(mutations(solo));
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("shutdown waits for the in-flight HTTP tail beyond the poll budget", async () => {
  const f = queuedFixture(),
    entered = deferred<void>(),
    tail = deferred<Response>();
  f.intercept(async (method) => {
    if (method === "PATCH") {
      entered.resolve();
      return tail.promise;
    }
    return undefined;
  });
  const worker = deliveryWorker(f);
  try {
    await worker.poll();
    await entered.promise;
    jest.spyOn(Date, "now").mockReturnValue((now + 11) * 1000);
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);
    tail.resolve(new Response(null, { status: 503 }));
    await stop;
    expect(stopped).toBe(true);
  } finally {
    tail.resolve(new Response(null, { status: 503 }));
    await worker.stop();
  }
});
