import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { config } from "../services/configService";
import { getMockStore } from "./mockStore";
import { getSubscriptionRepository } from "./subscriptionRepository";
import {
  readRenewalRecord,
  writeRenewalRecoveryRecord,
  listDueRenewalRecoveries,
} from "../db";
import type { GuildSubscription } from "../types/db";
import {
  renewalRecoverySchema,
  renewalRecoveryKey,
  renewalRecoveryCurrentKey,
  renewalRecoveryPointerSchema,
  assertRenewalRecoveryTransition,
  isRenewalRecoveryBlocking,
  renewalRecoveryNextCheck,
  readRenewalRecoveryCursor,
  writeRenewalRecoveryCursor,
  type RenewalRecovery,
  type RenewalRecoveryPointer,
} from "../types/renewalRecovery";

async function pointer(
  guildId: string,
): Promise<RenewalRecoveryPointer | undefined> {
  if (config.mock.enabled)
    return renewalRecoveryPointerSchema
      .optional()
      .parse(getMockStore().renewalRecoveryPointers.get(guildId));
  const raw = await readRenewalRecord(renewalRecoveryCurrentKey(guildId));
  if (!raw) return undefined;
  const { guildId: key, ...value } = raw;
  void key;
  return renewalRecoveryPointerSchema.parse(value);
}
async function get(key: string): Promise<RenewalRecovery | undefined> {
  if (config.mock.enabled)
    return renewalRecoverySchema
      .optional()
      .parse(getMockStore().renewalRecoveryRecords.get(key));
  const raw = await readRenewalRecord(key);
  if (!raw) return undefined;
  const { ownerGuildId, recoveryQueue, recoveryDueAt, ...value } = raw;
  void recoveryQueue;
  void recoveryDueAt;
  const record = renewalRecoverySchema.parse({
    ...value,
    guildId: ownerGuildId,
  });
  if (renewalRecoveryKey(record) !== key)
    throw new Error("Stored renewal recovery identity mismatch");
  return record;
}
async function write(input: {
  next: RenewalRecovery;
  expectedRevision?: string;
  expectedPointer?: RenewalRecoveryPointer;
  supersededWatch?: Extract<RenewalRecovery, { state: "watching" }>;
  expectedSubscription: GuildSubscription;
  blocking: boolean;
}): Promise<boolean> {
  const next = renewalRecoverySchema.parse(input.next);
  if (input.blocking !== isRenewalRecoveryBlocking(next))
    throw new Error("Renewal recovery fence must match state");
  if (!config.mock.enabled)
    return writeRenewalRecoveryRecord({ ...input, next });
  const store = getMockStore();
  const subscription = await getSubscriptionRepository().get(next.guildId);
  const key = renewalRecoveryKey(next);
  const current = store.renewalRecoveryPointers.get(next.guildId);
  if (
    subscription?.stripeSubscriptionId !== next.subscriptionId ||
    subscription?.stripeSubscriptionId !==
      input.expectedSubscription.stripeSubscriptionId ||
    subscription?.stripeSyncRevision !==
      input.expectedSubscription.stripeSyncRevision ||
    current?.revision !== input.expectedPointer?.revision ||
    store.renewalRecoveryRecords.get(key)?.revision !== input.expectedRevision
  )
    return false;
  if (input.supersededWatch) {
    const old = input.supersededWatch;
    if (
      store.renewalRecoveryRecords.get(renewalRecoveryKey(old))?.revision !==
      old.revision
    )
      return false;
    const { nextCheckAt, ...base } = old;
    void nextCheckAt;
    store.renewalRecoveryRecords.set(
      renewalRecoveryKey(old),
      renewalRecoverySchema.parse({
        ...base,
        state: "ended",
        revision: randomUUID(),
      }),
    );
  }
  store.renewalRecoveryRecords.set(key, structuredClone(next));
  store.renewalRecoveryPointers.set(next.guildId, {
    key,
    revision: next.revision,
    blocking: input.blocking,
  });
  return true;
}
function cannotReplacePaidWatch(
  previous: RenewalRecovery,
  next: RenewalRecovery,
): boolean {
  return (
    isRenewalRecoveryBlocking(previous) ||
    ((previous.state === "paid" || previous.state === "superseded") &&
      previous.projection.state === "pending") ||
    (previous.subscriptionId === next.subscriptionId &&
      (previous.paid.periodStart > next.paid.periodStart ||
        isDeepStrictEqual(previous.paid, next.paid) ||
        (previous.state !== "watching" &&
          previous.paid.periodEnd >= next.paid.periodEnd)))
  );
}
export function getRenewalRecoveryRepository() {
  return {
    get,
    async getCurrent(guildId: string): Promise<RenewalRecovery | undefined> {
      const current = await pointer(guildId);
      if (!current) return undefined;
      const record = await get(current.key);
      if (!record || record.guildId !== guildId)
        throw new Error("Missing or mismatched renewal recovery");
      return record;
    },
    async register(input: {
      record: RenewalRecovery;
      expectedSubscription: GuildSubscription;
    }): Promise<boolean> {
      const next = renewalRecoverySchema.parse(input.record);
      if (next.state !== "watching" || next.enforcementAccepted)
        throw new Error("New renewal recovery must start as a watch");
      const expectedPointer = await pointer(next.guildId);
      let previous: RenewalRecovery | undefined;
      if (expectedPointer) {
        previous = await get(expectedPointer.key);
        if (!previous || cannotReplacePaidWatch(previous, next)) return false;
      }
      const sameKey =
        previous && renewalRecoveryKey(previous) === renewalRecoveryKey(next);
      if (sameKey && previous) assertRenewalRecoveryTransition(next, previous);
      return write({
        next,
        expectedRevision: sameKey ? previous?.revision : undefined,
        supersededWatch:
          !sameKey &&
          previous?.state === "watching" &&
          !previous.enforcementAccepted
            ? previous
            : undefined,
        expectedSubscription: input.expectedSubscription,
        expectedPointer,
        blocking: false,
      });
    },
    async compareAndWrite(input: {
      next: RenewalRecovery;
      expectedRevision: string;
      expectedSubscription: GuildSubscription;
      blocking: boolean;
    }): Promise<boolean> {
      const next = renewalRecoverySchema.parse(input.next);
      const previous = await get(renewalRecoveryKey(next));
      const expectedPointer = await pointer(next.guildId);
      if (
        !previous ||
        previous.revision !== input.expectedRevision ||
        expectedPointer?.key !== renewalRecoveryKey(next)
      )
        return false;
      assertRenewalRecoveryTransition(next, previous);
      return write({ ...input, next, expectedPointer });
    },
    async listDue(input: {
      mode: "test" | "live";
      now: number;
      limit: number;
      cursor?: string;
    }): Promise<{ keys: string[]; cursor?: string }> {
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      )
        throw new Error("Invalid renewal batch limit");
      if (!config.mock.enabled) return listDueRenewalRecoveries(input);
      const cursor = readRenewalRecoveryCursor(input.cursor);
      if (cursor && cursor.recoveryQueue !== input.mode)
        throw new Error("Renewal cursor mode mismatch");
      const due = [...getMockStore().renewalRecoveryRecords.values()]
        .filter(
          (record) =>
            renewalRecoveryNextCheck(record) !== undefined &&
            (renewalRecoveryNextCheck(record) ?? Infinity) <= input.now &&
            record.mode === input.mode,
        )
        .map((record) => ({
          key: renewalRecoveryKey(record),
          at: renewalRecoveryNextCheck(record) ?? 0,
        }))
        .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
        .filter(
          (record) =>
            !cursor ||
            record.at > cursor.recoveryDueAt ||
            (record.at === cursor.recoveryDueAt && record.key > cursor.guildId),
        );
      const page = due.slice(0, input.limit);
      const last = page.at(-1);
      return {
        keys: page.map((record) => record.key),
        ...(last && due.length > input.limit
          ? {
              cursor: writeRenewalRecoveryCursor({
                guildId: last.key,
                recoveryQueue: input.mode,
                recoveryDueAt: last.at,
              }),
            }
          : {}),
      };
    },
  };
}
