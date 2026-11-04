import type { MeetingHistory } from "../types/db";
import { firstPublicationPinsSchema } from "../types/firstPublicationControl";
import {
  dynamoItemBytes,
  MAX_MEETING_ITEM_BYTES,
} from "../repositories/meetingUpdateDeliveryState";
import type {
  FirstPublicationReceipt,
  PlanMeeting,
  PublicationPage,
} from "./firstPublicationTypes";
const MAX_TRANSACTION_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_ITEMS = 100;
const RESERVED_MESSAGE_ID_DIGITS = 25;
export type PublicationCapacityEntry = {
  row: MeetingHistory;
  receipt: FirstPublicationReceipt;
};
export type PublicationPreviewCapacity = {
  entries: PublicationCapacityEntry[];
  control: Record<string, unknown>;
};
export function createFirstPublicationReceipt(
  meeting: Extract<PlanMeeting, { outcome: "ready" }>,
  options: {
    runId: string;
    planDigest: string;
    generation: number;
    now: string;
    processId: string;
  },
): FirstPublicationReceipt {
  const b = meeting.binding;
  return {
    schemaVersion: 1,
    runId: options.runId,
    generation: options.generation,
    authority: b.authority,
    key: meeting.key,
    planDigest: options.planDigest,
    sourceDigest: b.sourceDigest,
    channelId: b.channelId,
    botId: b.botId,
    payloads: b.payloads,
    pages: b.payloads.map(() => ({ kind: "prepared" })),
    ownerState: "running",
    outcome: "pending",
    updatedAt: options.now,
    processId: options.processId,
  };
}
export function firstPublicationOwner(receipt: FirstPublicationReceipt) {
  return {
    kind: "running" as const,
    purpose: "first_publication" as const,
    runId: receipt.runId,
    previewDigest: receipt.planDigest,
    receiptKey: receipt.authority,
    snapshot: receipt.sourceDigest,
  };
}
export function registeredFirstPublication(
  after: MeetingHistory,
  receipt: FirstPublicationReceipt,
) {
  const ids = receipt.pages.flatMap((p) =>
    p.kind === "verified" ? [p.messageId] : [],
  );
  if (new Set(ids).size !== ids.length || !after.updateDelivery) return null;
  after.notesChannelId = receipt.channelId;
  after.notesMessageIds = ids;
  after.updateDelivery = {
    ...after.updateDelivery,
    parts: {
      ...after.updateDelivery.parts,
      notesBody: {
        ...after.updateDelivery.parts.notesBody,
        acknowledged: after.updateDelivery.parts.notesBody.desired,
      },
    },
    progress: {
      kind: "synced",
      syncedAt: Math.floor(Date.parse(receipt.updatedAt) / 1000),
    },
  };
  delete after.updateDeliveryQueue;
  delete after.updateDeliveryDueAt;

  return after;
}

function limitedItemBytes(value: object, description: string) {
  const bytes = dynamoItemBytes(value);
  if (bytes > MAX_MEETING_ITEM_BYTES)
    throw Error(description + " exceeds DynamoDB's 400 KiB item limit");
  return bytes;
}
function receiptItems(receipt: FirstPublicationReceipt) {
  const pk = "PUBLICATION#" + receipt.authority;
  return [
    { pk, sk: "CURRENT", value: receipt },
    { pk, sk: "AUDIT#" + receipt.runId + "#" + "f".repeat(64), value: receipt },
  ];
}
export function assertPublicationTransactionCapacity(
  control: Record<string, unknown>,
  rows: MeetingHistory[],
  receipts: FirstPublicationReceipt[],
) {
  if (1 + rows.length + 2 * receipts.length > MAX_TRANSACTION_ITEMS)
    throw Error(
      "Publication batch exceeds 100 transaction items; select fewer meetings and preview again",
    );
  const items = [control, ...rows, ...receipts.flatMap(receiptItems)];
  const total = items.reduce(
    (sum, item) => sum + limitedItemBytes(item, "Publication transaction item"),
    0,
  );
  if (total > MAX_TRANSACTION_BYTES)
    throw Error(
      "Publication batch exceeds DynamoDB's 4 MiB limit; select fewer meetings and preview again",
    );
}
function capacityReceipt(
  receipt: FirstPublicationReceipt,
): FirstPublicationReceipt {
  return {
    ...receipt,
    ownerState: "settled",
    outcome: "verified",
    pages: receipt.pages.map((page, index): PublicationPage =>
      page.kind === "verified"
        ? page
        : {
            kind: "verified",
            at: receipt.updatedAt,
            messageId: String(index).padStart(RESERVED_MESSAGE_ID_DIGITS, "9"),
            fingerprint: "f".repeat(64),
          },
    ),
  };
}
export function assertFirstPublicationFits(
  row: MeetingHistory,
  receipt: FirstPublicationReceipt,
) {
  limitedItemBytes(
    { ...row, publicationRepair: firstPublicationOwner(receipt) },
    "Publication claim",
  );
  const completed = capacityReceipt(receipt);
  const registered = registeredFirstPublication(
    {
      ...row,
      publicationRepair: { ...firstPublicationOwner(receipt), kind: "settled" },
    },
    completed,
  );
  if (!registered) throw Error("Publication registration metadata is invalid");
  limitedItemBytes(registered, "Publication registration");
  for (const item of receiptItems(completed))
    limitedItemBytes(item, "Verified publication receipt");
}
export function assertFirstPublicationCapacity(
  entries: PublicationCapacityEntry[],
  control: Record<string, unknown>,
) {
  if (!entries.length) return;
  const rows = entries.map(({ row, receipt }) => {
    assertFirstPublicationFits(row, receipt);
    return { ...row, publicationRepair: firstPublicationOwner(receipt) };
  });
  const pins = firstPublicationPinsSchema.parse(control.publicationPins ?? {});
  pins[entries[0].receipt.runId] = {
    authorities: entries.map((e) => e.receipt.authority),
    settled: [],
  };
  assertPublicationTransactionCapacity(
    { ...control, publicationPins: pins },
    rows,
    entries.map((e) => e.receipt),
  );
}
