import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  parseMeetingUpdateHistory,
  assertMeetingItemSize,
} from "./meetingUpdateDeliveryState";
import type { MeetingHistory } from "../types/db";
import { firstPublicationSnapshot } from "../services/firstPublicationSource";
import {
  attemptSchema,
  digest,
  keyId,
  type FirstPublicationRepository,
  type FirstPublicationReceipt,
  type PublicationKey,
  type PublicationProfile,
  type RuntimeCompatibility,
} from "../services/firstPublicationTypes";
type RowChange = {
  key: PublicationKey;
  before: MeetingHistory;
  after: MeetingHistory;
};
type AttemptChange = {
  before: FirstPublicationReceipt | null;
  after: FirstPublicationReceipt;
};
type Commit = {
  controlBefore: Record<string, unknown>;
  controlAfter: Record<string, unknown>;
  rows: RowChange[];
  attempts: AttemptChange[];
};
export type FirstPublicationStore = {
  readRow(key: PublicationKey): Promise<MeetingHistory | undefined>;
  readAttempt(authority: string): Promise<FirstPublicationReceipt | null>;
  readControl(): Promise<Record<string, unknown>>;
  commit(change: Commit): Promise<"applied" | "stale">;
};
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
export type Pin = { authorities: string[]; settled: string[] };
export function readPublicationPins(
  control: Record<string, unknown>,
): Record<string, Pin> {
  const parsed = pinRecord.safeParse(control.publicationPins ?? {});
  if (!parsed.success) throw Error("Invalid publication pins");
  return parsed.data;
}
import { z } from "zod";
const pinRecord = z.record(
  z.string(),
  z
    .object({
      authorities: z.array(z.string()).min(1).max(25),
      settled: z.array(z.string()).max(25),
    })
    .strict(),
);
function owner(receipt: FirstPublicationReceipt) {
  return {
    kind: "running" as const,
    runId: receipt.runId,
    previewDigest: receipt.planDigest,
    receiptKey: receipt.authority,
    snapshot: receipt.sourceDigest,
  };
}
function owns(
  row: MeetingHistory,
  receipt: FirstPublicationReceipt,
  snapshot: Record<string, unknown>,
) {
  const actual = firstPublicationSnapshot(row);
  actual.publicationRepair = snapshot.publicationRepair;
  if (actual.publicationRepair === undefined) delete actual.publicationRepair;
  return (
    !row.archivedAt &&
    same(row.publicationRepair, owner(receipt)) &&
    same(actual, snapshot) &&
    digest(snapshot) === receipt.sourceDigest
  );
}
function settlePin(
  control: Record<string, unknown>,
  receipt: FirstPublicationReceipt,
) {
  const pins = readPublicationPins(control),
    pin = pins[receipt.runId];
  if (!pin || !pin.authorities.includes(receipt.authority))
    throw Error("Publication pin lost");
  pin.settled = [...new Set([...pin.settled, receipt.authority])];
  if (pin.authorities.every((a) => pin.settled.includes(a)))
    delete pins[receipt.runId];
  return { ...control, publicationPins: pins };
}
export type AcquireFirstPublication = {
  receipt: FirstPublicationReceipt;
  snapshot: Record<string, unknown>;
  runtime: Extract<RuntimeCompatibility, { kind: "compatible" }>;
};
export type BatchAcquisition = {
  entries: Array<{
    receipt: FirstPublicationReceipt;
    snapshot: Record<string, unknown>;
  }>;
  runtime: Extract<RuntimeCompatibility, { kind: "compatible" }>;
};
export type BatchFirstPublicationRepository = FirstPublicationRepository & {
  acquireBatch(input: BatchAcquisition): Promise<"owned" | "stale">;
};
export function createFirstPublicationRepository(
  store: FirstPublicationStore,
): BatchFirstPublicationRepository {
  async function acquireBatch(
    input: BatchAcquisition,
  ): Promise<"owned" | "stale"> {
    const control = await store.readControl();
    if (
      !same(control, input.runtime.control) ||
      control.servingGeneration !== input.runtime.generation ||
      control.publicationTransition
    )
      return "stale";
    const runId = input.entries[0]?.receipt.runId;
    if (
      !runId ||
      input.entries.length > 25 ||
      input.entries.some((e) => e.receipt.runId !== runId) ||
      new Set(input.entries.map((e) => e.receipt.authority)).size !==
        input.entries.length
    )
      return "stale";
    const pins = readPublicationPins(control);
    if (pins[runId] || Object.keys(pins).length >= 25) return "stale";
    const rows: RowChange[] = [],
      attempts: AttemptChange[] = [];
    for (const { receipt, snapshot } of input.entries) {
      attemptSchema.parse(receipt);
      const row = await store.readRow(receipt.key),
        prior = await store.readAttempt(receipt.authority);
      if (
        !row ||
        row.archivedAt ||
        !same(firstPublicationSnapshot(row), snapshot) ||
        digest(snapshot) !== receipt.sourceDigest ||
        row.publicationRepair?.kind === "running" ||
        row.notesChannelId ||
        row.notesMessageIds?.length ||
        row.summaryMessageId ||
        (prior &&
          (prior.ownerState === "running" || prior.outcome === "verified"))
      )
        return "stale";
      if (receipt.generation !== (prior?.generation ?? 0) + 1) return "stale";
      rows.push({
        key: receipt.key,
        before: row,
        after: { ...row, publicationRepair: owner(receipt) },
      });
      attempts.push({ before: prior, after: receipt });
    }
    pins[runId] = {
      authorities: input.entries.map((e) => e.receipt.authority),
      settled: [],
    };
    return (await store.commit({
      controlBefore: control,
      controlAfter: { ...control, publicationPins: pins },
      rows,
      attempts,
    })) === "applied"
      ? "owned"
      : "stale";
  }
  async function settle(
    receipt: FirstPublicationReceipt,
    snapshot: Record<string, unknown>,
    published: boolean,
  ): Promise<"applied" | "stale"> {
    const [row, prior, control] = await Promise.all([
      store.readRow(receipt.key),
      store.readAttempt(receipt.authority),
      store.readControl(),
    ]);
    if (
      prior?.ownerState === "settled" &&
      prior.runId === receipt.runId &&
      prior.outcome === (published ? "verified" : "unsent")
    )
      return "applied";
    if (
      !row ||
      !prior ||
      !same(prior, receipt) ||
      !owns(row, receipt, snapshot)
    )
      return "stale";
    if (
      published
        ? !receipt.pages.every((p) => p.kind === "verified")
        : receipt.pages.some(
            (p) => p.kind !== "prepared" && p.kind !== "rejected",
          )
    )
      return "stale";
    const after: MeetingHistory = {
      ...row,
      publicationRepair: { ...owner(receipt), kind: "settled" },
    };
    if (published) {
      const ids = receipt.pages.flatMap((p) =>
        p.kind === "verified" ? [p.messageId] : [],
      );
      if (new Set(ids).size !== ids.length || !row.updateDelivery)
        return "stale";
      after.notesChannelId = receipt.channelId;
      after.notesMessageIds = ids;
      after.updateDelivery = {
        ...row.updateDelivery,
        parts: {
          ...row.updateDelivery.parts,
          notesBody: {
            ...row.updateDelivery.parts.notesBody,
            acknowledged: row.updateDelivery.parts.notesBody.desired,
          },
        },
        progress: {
          kind: "synced",
          syncedAt: Math.floor(Date.parse(receipt.updatedAt) / 1000),
        },
      };
      delete after.updateDeliveryQueue;
      delete after.updateDeliveryDueAt;
    }
    const result = {
      ...receipt,
      ownerState: "settled" as const,
      outcome: published ? ("verified" as const) : ("unsent" as const),
    };
    return store.commit({
      controlBefore: control,
      controlAfter: settlePin(control, receipt),
      rows: [{ key: receipt.key, before: row, after }],
      attempts: [{ before: prior, after: result }],
    });
  }
  return {
    getStrong: store.readRow,
    readAttempt: store.readAttempt,
    acquireBatch,
    acquire: (input) =>
      acquireBatch({ entries: [input], runtime: input.runtime }),
    recordPage: async (before, after) => {
      attemptSchema.parse(after);
      const [row, prior, control] = await Promise.all([
        store.readRow(before.key),
        store.readAttempt(before.authority),
        store.readControl(),
      ]);
      if (prior && same(prior, after)) return "applied";
      if (
        !row ||
        !prior ||
        !same(prior, before) ||
        !same(row.publicationRepair, owner(before)) ||
        before.ownerState !== "running" ||
        after.ownerState !== "running" ||
        !same(
          { ...before, pages: after.pages, updatedAt: after.updatedAt },
          after,
        )
      )
        return "stale";
      const valid = before.pages.every(
        (p, i) =>
          same(p, after.pages[i]) ||
          ((p.kind === "prepared" || p.kind === "rejected") &&
            after.pages[i].kind === "submitted") ||
          ((p.kind === "submitted" ||
            (p.kind === "uncertain" &&
              p.messageId !== undefined &&
              after.pages[i].kind === "verified")) &&
            ["verified", "rejected", "uncertain"].includes(
              after.pages[i].kind,
            )),
      );
      if (!valid) return "stale";
      return store.commit({
        controlBefore: control,
        controlAfter: control,
        rows: [],
        attempts: [{ before, after }],
      });
    },
    settleVerified: (r, s) => settle(r, s, true),
    settleUnsent: (r, s) => settle(r, s, false),
    transferStoppedRun: async (before, after, snapshot) => {
      const [row, prior, control] = await Promise.all([
        store.readRow(before.key),
        store.readAttempt(before.authority),
        store.readControl(),
      ]);
      if (
        !row ||
        !prior ||
        !same(prior, before) ||
        !owns(row, before, snapshot) ||
        !same(
          {
            ...before,
            processId: after.processId,
            updatedAt: after.updatedAt,
            resolutionDigests: after.resolutionDigests,
          },
          after,
        )
      )
        return "stale";
      return (await store.commit({
        controlBefore: control,
        controlAfter: control,
        rows: [],
        attempts: [{ before, after }],
      })) === "applied"
        ? "owned"
        : "stale";
    },
  };
}
export function createMemoryFirstPublicationStore(
  initial: MeetingHistory[],
  initialControl: Record<string, unknown>,
) {
  const rows = new Map(initial.map((r) => [keyId(r), structuredClone(r)])),
    attempts = new Map<string, FirstPublicationReceipt>();
  const store = {
    control: structuredClone(initialControl),
    attempts,
    rows,
    readRow: async (key: PublicationKey) => {
      const row = rows.get(keyId(key));
      return row ? structuredClone(row) : undefined;
    },
    readAttempt: async (a: string) => structuredClone(attempts.get(a) ?? null),
    readControl: async () => structuredClone(store.control),
    async commit(c: Commit): Promise<"applied" | "stale"> {
      if (
        !same(store.control, c.controlBefore) ||
        c.rows.some((r) => !same(rows.get(keyId(r.key)), r.before)) ||
        c.attempts.some(
          (a) => !same(attempts.get(a.after.authority) ?? null, a.before),
        )
      )
        return "stale";
      store.control = structuredClone(c.controlAfter);
      for (const r of c.rows) rows.set(keyId(r.key), structuredClone(r.after));
      for (const a of c.attempts)
        attempts.set(a.after.authority, structuredClone(a.after));
      return "applied";
    },
    archive(key: PublicationKey, archived: boolean) {
      const row = rows.get(keyId(key));
      if (!row) return "missing";
      if (row.publicationRepair?.kind === "running") return "conflict";
      if (archived) row.archivedAt = "2026-11-02T00:00:00Z";
      else delete row.archivedAt;
      return "applied";
    },
    reserveIncompatible() {
      if (Object.keys(readPublicationPins(store.control)).length)
        return "stale";
      store.control = { ...store.control, publicationTransition: "reserved" };
      return "owned";
    },
  };
  return store;
}
function condition(before: Record<string, unknown>, fields: string[]) {
  const names: Record<string, string> = {},
    values: Record<string, unknown> = {};
  const clauses = fields.map((field, i) => {
    const n = "#c" + i,
      v = ":c" + i;
    names[n] = field;
    if (before[field] === undefined) return "attribute_not_exists(" + n + ")";
    values[v] = before[field];
    return n + " = " + v;
  });
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? {
          ExpressionAttributeValues: marshall(values, {
            removeUndefinedValues: true,
          }),
        }
      : {}),
  };
}
const historyFields = [
  "guildId",
  "channelId_timestamp",
  "meetingId",
  "status",
  "ownerInstanceId",
  "executionVersion",
  "canonicalWriter",
  "checkpoint",
  "recovery",
  "completionPolicy",
  "delivery",
  "notes",
  "notesVersion",
  "notesHistory",
  "notesDelta",
  "contentRevision",
  "contentMutation",
  "notesLastEditedAt",
  "notesLastEditedBy",
  "suggestionsHistory",
  "transcriptS3Key",
  "operatorRecovery",
  "textChannelId",
  "channelId",
  "timestamp",
  "archivedAt",
  "archivedByUserId",
  "capture",
  "captureCoverage",
  "processing",
  "updateDelivery",
  "notesChannelId",
  "notesMessageIds",
  "summaryMessageId",
  "publicationRepair",
];
export function buildFirstPublicationCommit(
  profile: PublicationProfile,
  c: Commit,
): TransactWriteItem[] {
  const items: TransactWriteItem[] = [];
  if (!same(c.controlBefore, c.controlAfter))
    items.push({
      Update: {
        TableName: profile.controlTable,
        Key: marshall({ pk: "ENV", sk: "CONTROL" }),
        UpdateExpression: "SET #pins = :pins",
        ...condition(c.controlBefore, [
          "servingGeneration",
          "coordinatorEpoch",
          "publicationPins",
          "publicationTransition",
          "deployment",
          "servingMembers",
        ]),
        ExpressionAttributeNames: {
          ...condition(c.controlBefore, [
            "servingGeneration",
            "coordinatorEpoch",
            "publicationPins",
            "publicationTransition",
            "deployment",
            "servingMembers",
          ]).ExpressionAttributeNames,
          "#pins": "publicationPins",
        },
        ExpressionAttributeValues: {
          ...condition(c.controlBefore, [
            "servingGeneration",
            "coordinatorEpoch",
            "publicationPins",
            "publicationTransition",
            "deployment",
            "servingMembers",
          ]).ExpressionAttributeValues,
          ...marshall({ ":pins": c.controlAfter.publicationPins }),
        },
      },
    });
  else
    items.push({
      ConditionCheck: {
        TableName: profile.controlTable,
        Key: marshall({ pk: "ENV", sk: "CONTROL" }),
        ...condition(c.controlBefore, [
          "servingGeneration",
          "coordinatorEpoch",
          "publicationPins",
          "publicationTransition",
          "deployment",
          "servingMembers",
        ]),
      },
    });
  for (const r of c.rows) {
    assertMeetingItemSize(r.after);
    const proof = condition(firstPublicationSnapshot(r.before), historyFields),
      names = { ...proof.ExpressionAttributeNames },
      values = { ...proof.ExpressionAttributeValues },
      set: string[] = [],
      remove: string[] = [];
    for (const [i, field] of [
      "publicationRepair",
      "notesChannelId",
      "notesMessageIds",
      "updateDelivery",
      "updateDeliveryQueue",
      "updateDeliveryDueAt",
    ].entries()) {
      const n = "#w" + i,
        v = ":w" + i;
      names[n] = field;
      const value = Reflect.get(r.after, field);
      if (value === undefined) remove.push(n);
      else {
        set.push(n + " = " + v);
        Object.assign(
          values,
          marshall({ [v]: value }, { removeUndefinedValues: true }),
        );
      }
    }
    items.push({
      Update: {
        TableName: profile.historyTable,
        Key: marshall(r.key),
        ConditionExpression:
          "attribute_exists(guildId) AND " + proof.ConditionExpression,
        UpdateExpression: [
          set.length ? "SET " + set.join(", ") : "",
          remove.length ? "REMOVE " + remove.join(", ") : "",
        ]
          .filter(Boolean)
          .join(" "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    });
  }
  for (const a of c.attempts) {
    const key = { pk: "PUBLICATION#" + a.after.authority, sk: "CURRENT" };
    items.push({
      Put: {
        TableName: profile.controlTable,
        Item: marshall(
          { ...key, value: a.after },
          { removeUndefinedValues: true },
        ),
        ...condition(a.before ? { value: a.before } : {}, ["value"]),
      },
    });
    items.push({
      Put: {
        TableName: profile.controlTable,
        Item: marshall(
          {
            pk: key.pk,
            sk: "AUDIT#" + a.after.runId + "#" + digest(a.after),
            value: a.after,
          },
          { removeUndefinedValues: true },
        ),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });
  }
  return items;
}
export function createDynamoFirstPublicationRepository(
  client: DynamoDBClient,
  profile: PublicationProfile,
): BatchFirstPublicationRepository {
  async function read(table: string, key: Record<string, string>) {
    const r = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    return r.Item ? unmarshall(r.Item) : null;
  }
  const store: FirstPublicationStore = {
    readRow: async (key) => {
      const r = await read(profile.historyTable, key);
      return r ? parseMeetingUpdateHistory(r) : undefined;
    },
    readAttempt: async (authority) => {
      const r = await read(profile.controlTable, {
        pk: "PUBLICATION#" + authority,
        sk: "CURRENT",
      });
      return r ? attemptSchema.parse(r.value) : null;
    },
    readControl: async () => {
      const r = await read(profile.controlTable, { pk: "ENV", sk: "CONTROL" });
      if (!r) throw Error("Deployment control unavailable");
      return r;
    },
    commit: async (c) => {
      const items = buildFirstPublicationCommit(profile, c);
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: items,
            ClientRequestToken: digest(c).slice(0, 36),
          }),
        );
        return "applied";
      } catch (e) {
        const [control, rows, attempts] = await Promise.all([
          store.readControl(),
          Promise.all(c.rows.map((r) => store.readRow(r.key))),
          Promise.all(
            c.attempts.map((a) => store.readAttempt(a.after.authority)),
          ),
        ]);
        if (
          same(control, c.controlAfter) &&
          rows.every((r, i) => same(r, c.rows[i].after)) &&
          attempts.every((a, i) => same(a, c.attempts[i].after))
        )
          return "applied";
        if (
          e instanceof Error &&
          [
            "TransactionCanceledException",
            "ConditionalCheckFailedException",
          ].includes(e.name)
        )
          return "stale";
        throw Error("Publication transaction uncertain; reconcile", {
          cause: e,
        });
      }
    },
  };
  return createFirstPublicationRepository(store);
}
