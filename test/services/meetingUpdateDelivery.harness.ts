import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import type { MeetingDeliveryDependencies } from "../../src/services/meetingUpdateDeliveryTypes";
import type { deliveryFixture } from "./meetingUpdateDelivery.fixture";
export function initializeDeliveryClock() {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
}
export function settleDeliveryWorks() {
  jest.restoreAllMocks();
}
/** `controller` stands in for the worker's stop signal. */
export function runDelivery(
  f: ReturnType<typeof deliveryFixture>,
  reconcile = false,
  timeoutMs = 10000,
  options: Partial<MeetingDeliveryDependencies> = {},
) {
  const controller = new AbortController();
  const service = createMeetingUpdateDeliveryService({
    repository: f.repository,
    discord: createDiscordMeetingUpdateTransport({
      token: "synthetic-token",
      fetchImpl: f.fetchImpl,
    }),
    now: () => Math.floor(Date.now() / 1000),
    random: () => 0,
    requestTimeoutMs: timeoutMs,
    ...options,
  });
  const promise = service[
    reconcile ? "reconcileMeetingUpdate" : "deliverMeetingUpdate"
  ]({ key, signal: controller.signal });
  return { controller, promise, service };
}
