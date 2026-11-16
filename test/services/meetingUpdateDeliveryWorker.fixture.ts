import "./meetingUpdateDeliveryRuntime";
import { createMeetingUpdateDeliveryWorker } from "../../src/services/meetingUpdateDeliveryWorkerService";
import type {
  MeetingDeliveryRunInput,
  MeetingDeliveryRunResult,
} from "../../src/services/meetingUpdateDeliveryTypes";
import { history, pending, now } from "../types/meetingUpdateDelivery.fixture";
import { deferred } from "./meetingUpdateDelivery.fixture";
export { deferred, now };
let generation = 0;
export function workerFixture(count = 1) {
  const prefix = `synthetic-worker-${++generation}`;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...history(),
    channelId_timestamp: `${prefix}#${i}`,
    contentRevision: 1,
    updateDelivery: pending(),
  }));
  const keys = rows.map(({ guildId, channelId_timestamp }) => ({
    guildId,
    channelId_timestamp,
  }));
  const repository = {
    getStrong: jest.fn(async (key: (typeof keys)[number]) =>
      rows.find((r) => r.channelId_timestamp === key.channelId_timestamp),
    ),
    listDue: jest.fn(async (input: { limit: number; cursor?: string }) => {
      const offset = Number(input.cursor ?? 0),
        end = Math.min(count, offset + input.limit);
      return {
        keys: keys.slice(offset, end),
        ...(end < count ? { cursor: String(end) } : {}),
      };
    }),
  };
  const deliver = jest.fn(
    async (
      _input: MeetingDeliveryRunInput,
    ): Promise<MeetingDeliveryRunResult> => {
      _input.signal?.throwIfAborted();
      return {
        kind: "settled",
        capturedRevision: null,
      };
    },
  );
  const reconcile = jest.fn(deliver);
  const worker = createMeetingUpdateDeliveryWorker({
    repository,
    deliver,
    reconcile,
    now: () => Date.now() / 1000,
    isEligible: () => true,
  });
  return {
    worker,
    repository,
    deliver,
    reconcile,
    keys,
    rows,
    clean: () => worker.stop(),
  };
}
