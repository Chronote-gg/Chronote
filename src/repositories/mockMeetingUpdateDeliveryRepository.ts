import type { MeetingHistory } from "../types/db";
import type { WorkAdmissionAuthority } from "../types/deploymentControl";
import {
  MEETING_UPDATE_DELIVERY_QUEUE,
  writeMeetingUpdateDeliveryCursor,
  type MeetingUpdateKey,
} from "../types/meetingUpdateDelivery";
import {
  claimDelivery,
  canRegisterPointers,
  transitionDelivery,
  validateDue,
  type MeetingUpdateDeliveryRepository,
} from "./meetingUpdateDeliveryRepository";
import {
  assertMeetingItemSize,
  meetingUpdateKeySchema,
  isExactContentMutation,
  canCompareContentWrite,
  parseMeetingUpdateHistory,
  prepareContentWrite,
  withDelivery,
} from "./meetingUpdateDeliveryState";

export function createMockMeetingUpdateDeliveryRepository(
  histories: Map<string, MeetingHistory[]>,
  admit: (authority: WorkAdmissionAuthority) => boolean,
): MeetingUpdateDeliveryRepository {
  function read(key: MeetingUpdateKey, signal?: AbortSignal) {
    signal?.throwIfAborted();
    meetingUpdateKeySchema.parse(key);
    const row = histories
      .get(key.guildId)
      ?.find((item) => item.channelId_timestamp === key.channelId_timestamp);
    return row
      ? parseMeetingUpdateHistory({ ...structuredClone(row) })
      : undefined;
  }
  function save(next: MeetingHistory) {
    assertMeetingItemSize(next);
    const rows = histories.get(next.guildId);
    const index = rows?.findIndex(
      (row) => row.channelId_timestamp === next.channelId_timestamp,
    );
    if (!rows || index === undefined || index < 0)
      throw new Error("Missing mock meeting");
    rows[index] = structuredClone(next);
  }
  return {
    async getStrong(key, signal) {
      return read(key, signal);
    },
    async updateContentAndDelivery(input, signal) {
      const row = read(input.key, signal);
      if (isExactContentMutation(row, input))
        return { kind: "committed", history: row };
      if (!canCompareContentWrite(row, input)) return { kind: "conflict" };
      const next = prepareContentWrite(row, input);
      save(next);
      return { kind: "committed", history: structuredClone(next) };
    },
    async claim(input) {
      input.signal?.throwIfAborted();
      if (!admit(input.authority)) return "stale";
      const row = read(input.key, input.signal);
      if (!row) return "stale";
      const delivery = claimDelivery(row, input);
      if (!delivery) return "stale";
      save(withDelivery(row, delivery));
      return "claimed";
    },
    async transition(input) {
      const row = read(input.key, input.signal);
      if (!row) return "stale";
      const delivery = transitionDelivery(row, input);
      if (!delivery) return "stale";
      save(withDelivery(row, delivery));
      return "applied";
    },
    async registerNotesPointers(input) {
      const row = read(input.key, input.signal);
      if (!row || !canRegisterPointers(row, input)) return "stale";
      save({
        ...row,
        notesChannelId: input.nextPointers.notesChannelId ?? undefined,
        notesMessageIds: input.nextPointers.notesMessageIds,
      });
      return "applied";
    },
    async listDue(input) {
      input.signal?.throwIfAborted();
      const cursor = validateDue(input);
      const rows = [...histories.values()]
        .flat()
        .filter(
          (row): row is MeetingHistory & { updateDeliveryDueAt: number } =>
            row.updateDeliveryQueue === MEETING_UPDATE_DELIVERY_QUEUE &&
            row.updateDeliveryDueAt !== undefined &&
            row.updateDeliveryDueAt <= input.now,
        )
        .sort(
          (left, right) =>
            left.updateDeliveryDueAt - right.updateDeliveryDueAt ||
            (left.guildId < right.guildId
              ? -1
              : left.guildId > right.guildId
                ? 1
                : 0) ||
            (left.channelId_timestamp < right.channelId_timestamp
              ? -1
              : left.channelId_timestamp > right.channelId_timestamp
                ? 1
                : 0),
        )
        .filter(
          (row) =>
            !cursor ||
            row.updateDeliveryDueAt > cursor.updateDeliveryDueAt ||
            (row.updateDeliveryDueAt === cursor.updateDeliveryDueAt &&
              (row.guildId > cursor.guildId ||
                (row.guildId === cursor.guildId &&
                  row.channelId_timestamp > cursor.channelId_timestamp))),
        );
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        keys: page.map(({ guildId, channelId_timestamp }) => ({
          guildId,
          channelId_timestamp,
        })),
        ...(last && rows.length > page.length
          ? {
              cursor: writeMeetingUpdateDeliveryCursor({
                guildId: last.guildId,
                channelId_timestamp: last.channelId_timestamp,
                updateDeliveryQueue: MEETING_UPDATE_DELIVERY_QUEUE,
                updateDeliveryDueAt: last.updateDeliveryDueAt,
              }),
            }
          : {}),
      };
    },
  };
}
