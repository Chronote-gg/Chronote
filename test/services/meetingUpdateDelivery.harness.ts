import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
  releaseAcknowledgedRuntimeWork,
} from "../../src/services/runtimeWorkAdmissionService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { key, now } from "../types/meetingUpdateDelivery.fixture";
import type { MeetingDeliveryDependencies } from "../../src/services/meetingUpdateDeliveryTypes";
import type { deliveryFixture } from "./meetingUpdateDelivery.fixture";
const works: ReturnType<typeof beginRuntimeWorkClaim>[] = [];
export function initializeDeliveryClock() {
  jest.spyOn(Date, "now").mockReturnValue(now * 1000);
}
export async function settleDeliveryWorks() {
  for (const work of works.splice(0)) {
    if (
      getRuntimeWorkAdmissionCheckpoints().some(
        (item) => item.signal === work.signal && item.claim,
      )
    )
      work.acknowledgeTerminal();
    await work.settle();
  }
  jest.restoreAllMocks();
}
export function runDelivery(
  f: ReturnType<typeof deliveryFixture>,
  reconcile = false,
  timeoutMs = 10000,
  options: Partial<MeetingDeliveryDependencies> = {},
) {
  const work = beginRuntimeWorkClaim(
    "meeting_update_delivery",
    crypto.randomUUID(),
  );
  works.push(work);
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
  const promise = work.trackPromise(() =>
    service[reconcile ? "reconcileMeetingUpdate" : "deliverMeetingUpdate"]({
      key,
      work,
      signal: work.signal,
    }),
  );
  return { work, promise, service };
}
export { getRuntimeWorkAdmissionCheckpoints, releaseAcknowledgedRuntimeWork };
