/** @jest-environment node */
import { withDelivery } from "../../src/repositories/meetingUpdateDeliveryState";
import "./meetingUpdateDeliveryRuntime";
import { createMeetingUpdateDeliveryWorker } from "../../src/services/meetingUpdateDeliveryWorkerService";
import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
import { deliveryFixture, deferred } from "./meetingUpdateDelivery.fixture";
import { now } from "../types/meetingUpdateDelivery.fixture";
test("shutdown retains the genuine service claim and HTTP tail beyond the poll budget", async () => {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
  const f = deliveryFixture(),
    entered = deferred<void>(),
    tail = deferred<Response>();
  f.setRow(withDelivery(f.input.history, f.input.history.updateDelivery));
  f.intercept(async (method) => {
    if (method === "PATCH") {
      entered.resolve();
      return tail.promise;
    }
    return undefined;
  });
  const service = createMeetingUpdateDeliveryService({
    repository: f.repository,
    discord: createDiscordMeetingUpdateTransport({
      token: "synthetic",
      fetchImpl: f.fetchImpl,
    }),
    now: () => now,
  });
  const worker = createMeetingUpdateDeliveryWorker({
    repository: f.repository,
    begin: beginRuntimeWorkClaim,
    deliver: service.deliverMeetingUpdate,
    reconcile: service.reconcileMeetingUpdate,
    now: () => now,
  });
  try {
    await worker.poll();
    await entered.promise;
    jest.spyOn(Date, "now").mockReturnValue((now + 11) * 1000);
    const owned = () =>
      getRuntimeWorkAdmissionCheckpoints().filter(
        (c) => c.domain === "meeting_update_delivery" && c.claim,
      );
    expect(owned()).toHaveLength(1);
    expect(owned()[0].effects.length).toBeGreaterThan(0);
    let stopped = false;
    const stop = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(owned()).toHaveLength(1);
    tail.resolve(new Response(null, { status: 503 }));
    await stop;
    expect(owned()).toHaveLength(0);
  } finally {
    tail.resolve(new Response(null, { status: 503 }));
    await worker.stop();
    jest.restoreAllMocks();
  }
});
