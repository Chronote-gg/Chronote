import "./meetingUpdateDeliveryRuntime";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";
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
  const works: ReturnType<typeof beginRuntimeWorkClaim>[] = [];
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
      _input.work.signal.throwIfAborted();
      return {
        kind: "settled",
        capturedRevision: null,
        noClaim: { kind: "never_admitted" },
      };
    },
  );
  const reconcile = jest.fn(deliver);
  const begin = jest.fn((...args: Parameters<typeof beginRuntimeWorkClaim>) => {
    const work = beginRuntimeWorkClaim(...args);
    works.push(work);
    return work;
  });
  const worker = createMeetingUpdateDeliveryWorker({
    repository,
    begin,
    deliver,
    reconcile,
    now: () => Date.now() / 1000,
  });
  function checkpoint(work: ReturnType<typeof beginRuntimeWorkClaim>) {
    return getRuntimeWorkAdmissionCheckpoints().find(
      (c) => c.signal === work.signal,
    );
  }
  function claimed(input: MeetingDeliveryRunInput) {
    const claim = {
      claimId: input.key.channelId_timestamp,
      instanceId: "owner",
      expiresAt: now + 60,
    };
    input.work.recordClaim(claim);
    input.work.claimed();
    return claim;
  }
  async function clean() {
    await worker.stop();
    for (const work of works) {
      const current = checkpoint(work);
      if (!current) continue;
      await work.settle();
      work.acknowledgeMeetingUpdateDelivery({
        durable: {
          deliveryRevision: "synthetic-cleanup",
          claim: current.claim ?? null,
        },
      });
    }
  }
  return {
    worker,
    repository,
    deliver,
    reconcile,
    begin,
    keys,
    rows,
    works,
    claimed,
    checkpoint,
    clean,
  };
}
