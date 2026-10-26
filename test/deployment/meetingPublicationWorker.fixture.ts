import type { MeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
import { createMeetingUpdateDeliveryService } from "../../src/services/meetingUpdateDeliveryService";
import { createMeetingUpdateDeliveryWorker } from "../../src/services/meetingUpdateDeliveryWorkerService";
import { createDiscordMeetingUpdateTransport } from "../../src/services/discordMeetingUpdateTransport";
import { beginRuntimeWorkClaim } from "../../src/services/runtimeWorkAdmissionService";
export function publicationWorker(input: {
  repository: MeetingUpdateDeliveryRepository;
  fetchImpl: typeof fetch;
}) {
  const service = createMeetingUpdateDeliveryService({
    repository: input.repository,
    discord: createDiscordMeetingUpdateTransport({
      token: "synthetic",
      fetchImpl: input.fetchImpl,
    }),
    now: () => Math.floor(Date.now() / 1000),
    random: () => 0,
    requestTimeoutMs: 10000,
  });
  return createMeetingUpdateDeliveryWorker({
    repository: input.repository,
    begin: beginRuntimeWorkClaim,
    deliver: service.deliverMeetingUpdate,
    reconcile: service.reconcileMeetingUpdate,
    now: () => Math.floor(Date.now() / 1000),
  });
}
