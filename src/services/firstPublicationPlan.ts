import {
  assertFirstPublicationCapacity,
  assertFirstPublicationFits,
  createFirstPublicationReceipt,
  type PublicationPreviewCapacity,
} from "./firstPublicationCapacity";
import type { MeetingHistory } from "../types/db";
import {
  buildMeetingNotesEmbeds,
  batchMeetingNotesEmbeds,
} from "../utils/meetingNotes";
import { normalizePublicationEmbeds } from "./recoveryDiscordPublicationTypes";
import { z } from "zod";
import {
  bindFirstPublicationSource,
  firstPublicationSnapshot,
  recoveryV2Schema,
} from "./firstPublicationSource";
import {
  digest,
  keyId,
  planSchema,
  type FirstPublicationPlan,
  type FirstPublicationDependencies,
  type PublicationSelection,
  type PlanMeeting,
  type PublicationPayload,
  type FirstPublicationReceipt,
} from "./firstPublicationTypes";
import type { DiscordEditorMessage } from "./discordMessageEditor";
const PREVIEW_RUN_ID = "f".repeat(36);
const PREVIEW_PLAN_DIGEST = "f".repeat(64);
// Operator process identities are local: plus a UUID.
const LOCAL_PROCESS_ID_LENGTH = 42;
const components = z.array(
  z.object({
    type: z.literal(1),
    components: z.array(
      z.object({
        type: z.literal(2),
        style: z.literal(5),
        label: z.string(),
        url: z.url(),
      }),
    ),
  }),
);
export function messageFingerprint(message: DiscordEditorMessage): string {
  return digest({
    embeds: normalizePublicationEmbeds(message.embeds),
    components: components.parse(message.components),
  });
}
export function expectedFingerprint(payload: PublicationPayload): string {
  return digest({
    embeds: normalizePublicationEmbeds(payload.embeds),
    components: components.parse(payload.components),
  });
}
export function verifyFirstPublicationMessage(
  message: DiscordEditorMessage | null,
  payload: PublicationPayload,
  channelId: string,
  botId: string,
): string {
  if (
    !message ||
    message.channel_id !== channelId ||
    message.author.id !== botId ||
    !message.author.bot ||
    message.webhook_id ||
    message.content ||
    message.attachments.length ||
    messageFingerprint(message) !== expectedFingerprint(payload)
  )
    throw Error("Discord message verification failed");
  return messageFingerprint(message);
}
export function renderFirstPublication(
  row: MeetingHistory,
): PublicationPayload[] {
  const embeds = buildMeetingNotesEmbeds({
    ...row,
    notesBody: row.notes ?? "",
    meetingName: `Recovered notes | UTC ${row.timestamp}`,
    footerText: `v${row.notesVersion} | Recovered notes`,
  });
  return batchMeetingNotesEmbeds(embeds).map((batch) => ({
    embeds: batch.map((e) => Object.fromEntries(Object.entries(e.toJSON()))),
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: "Open in Chronote",
            url: `https://chronote.gg/portal/meetings/${row.guildId}/${encodeURIComponent(row.channelId_timestamp)}`,
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  }));
}
export function firstPublicationDigest(plan: FirstPublicationPlan): string {
  const { digest: _digest, ...value } = plan;
  void _digest;
  return digest(value);
}
export async function verifyPublishedReceipt(
  receipt: FirstPublicationReceipt,
  row: MeetingHistory,
  deps: FirstPublicationDependencies,
): Promise<string[]> {
  const payloads = renderFirstPublication(row);
  if (
    receipt.ownerState !== "settled" ||
    receipt.outcome !== "verified" ||
    receipt.pages.length !== payloads.length ||
    digest(receipt.payloads) !== digest(payloads) ||
    receipt.channelId !== row.notesChannelId
  )
    throw Error("Prior publication differs; reconcile");
  const ids: string[] = [];
  for (const [i, page] of receipt.pages.entries()) {
    if (page.kind !== "verified")
      throw Error("Publication incomplete; reconcile");
    const message = await deps.discord.getMessage(
      receipt.channelId,
      page.messageId,
    );
    if (
      verifyFirstPublicationMessage(
        message,
        payloads[i],
        receipt.channelId,
        receipt.botId,
      ) !== page.fingerprint
    )
      throw Error("Prior publication changed; reconcile");
    ids.push(page.messageId);
  }
  if (
    new Set(ids).size !== ids.length ||
    digest(ids) !== digest(row.notesMessageIds)
  )
    throw Error("Publication pointers differ; reconcile");
  return ids;
}
export async function previewFirstPublication(
  selection: PublicationSelection,
  deps: FirstPublicationDependencies,
): Promise<FirstPublicationPlan> {
  if (
    selection.length < 1 ||
    selection.length > 25 ||
    new Set(selection.map(keyId)).size !== selection.length
  )
    throw Error("Select unique 1 to 25 meetings");
  if ((await deps.identity()) !== deps.profile.accountId)
    throw Error("AWS account mismatch");
  const meetings: PlanMeeting[] = [],
    capacity: PublicationPreviewCapacity = { entries: [], control: {} };
  for (const key of selection)
    meetings.push(await previewMeeting(key, deps, capacity));
  const bounded = boundPreviewCapacity(meetings, capacity);
  const plan: FirstPublicationPlan = {
    schemaVersion: 1,
    operation: "publish",
    profile: deps.profile,
    createdAt: deps.now(),
    ready: bounded.every((m) => m.outcome !== "blocked"),
    meetings: bounded,
    resolution: [],
    digest: "",
  };
  plan.digest = firstPublicationDigest(plan);
  return planSchema.parse(plan);
}
async function assertEligible(
  row: MeetingHistory,
  receipt: FirstPublicationReceipt | null,
  key: PublicationSelection[number],
  deps: FirstPublicationDependencies,
) {
  if (
    [
      receipt?.ownerState === "running",
      row.publicationRepair?.kind === "running",
      row.notesChannelId,
      row.notesMessageIds?.length,
      row.summaryMessageId,
      row.ownerInstanceId,
      row.executionVersion,
      row.recovery,
      row.checkpoint,
      row.updateDelivery?.createdCandidates.length,
      row.updateDelivery?.cleanupCandidates.length,
      row.updateDelivery && "attempt" in row.updateDelivery.progress,
    ].some(Boolean)
  )
    throw Error("Existing publication work; use reconcile");
  if (
    row.updateDelivery?.policy.kind !== "held" ||
    row.updateDelivery.policy.reason !== "stored_only" ||
    (await deps.targetActive(key, row.meetingId))
  )
    throw Error("Meeting is not eligible for first publication");
}
async function previewMeeting(
  key: PublicationSelection[number],
  deps: FirstPublicationDependencies,
  capacity: PublicationPreviewCapacity,
): Promise<PlanMeeting> {
  try {
    const row = await deps.repository.getStrong(key);
    if (!row) throw Error("Meeting not found");
    if (row.archivedAt !== undefined) {
      z.iso.datetime().parse(row.archivedAt);
      return { key, outcome: "skipped_archived" };
    }
    const r = recoveryV2Schema.parse(row.operatorRecovery);
    const manifest = JSON.parse(await deps.readObject(r.manifestS3Key));
    const prefix = r.manifestS3Key.slice(0, -"manifest.json".length);
    const [notes, transcript] = await Promise.all([
      deps.readObject(prefix + "notes.md"),
      deps.readObject(prefix + "transcript.json"),
    ]);
    const bound = bindFirstPublicationSource(deps.profile, row, manifest, {
      notes,
      transcript,
    });
    const bot = await deps.discord.getBotIdentity();
    const binding = {
      authority: bound.authority,
      recoveryId: bound.recoveryId,
      sourceDigest: bound.sourceDigest,
      manifestDigest: bound.manifestDigest,
      notesSha256: bound.notesSha256,
      notesVersion: row.notesVersion ?? 1,
      channelId: row.textChannelId ?? "",
      botId: bot.id,
      snapshot: firstPublicationSnapshot(row),
      payloads: renderFirstPublication(row),
    };
    const receipt = await deps.repository.readAttempt(bound.authority);
    if (receipt?.outcome === "verified") {
      await verifyPublishedReceipt(receipt, row, deps);
      return { key, outcome: "already_published", binding, receipt };
    }
    await assertEligible(row, receipt, key, deps);
    const [destination, duplicates, runtime] = await Promise.all([
      deps.discord.inspectDestination(key.guildId, binding.channelId),
      deps.discord.duplicateEvidence(key, binding.channelId),
      deps.runtime(),
    ]);
    if (!destination.allowed)
      throw Error(destination.reason ?? "Destination inaccessible");
    if (duplicates.ambiguous)
      throw Error("Ambiguous existing publication; reconcile");
    if (runtime.kind !== "compatible") throw Error(runtime.reason);
    const projectedReceipt = createFirstPublicationReceipt(
      { key, outcome: "ready", binding },
      {
        runId: PREVIEW_RUN_ID,
        planDigest: PREVIEW_PLAN_DIGEST,
        generation: (receipt?.generation ?? 0) + 1,
        now: deps.now(),
        processId: deps.processId.padEnd(LOCAL_PROCESS_ID_LENGTH, "_"),
      },
    );
    assertFirstPublicationFits(row, projectedReceipt);
    capacity.entries.push({ row, receipt: projectedReceipt });
    capacity.control = runtime.control;
    return { key, outcome: "ready", binding };
  } catch (e) {
    return { key, outcome: "blocked", reason: previewError(e) };
  }
}
function previewError(e: unknown) {
  if (e instanceof z.ZodError) return "Unsupported or invalid recovery data";
  return e instanceof Error ? e.message : "Read failed";
}

function boundPreviewCapacity(
  meetings: PlanMeeting[],
  capacity: PublicationPreviewCapacity,
): PlanMeeting[] {
  try {
    assertFirstPublicationCapacity(capacity.entries, capacity.control);
    return meetings;
  } catch (error) {
    return meetings.map((meeting) =>
      meeting.outcome === "ready"
        ? { key: meeting.key, outcome: "blocked", reason: previewError(error) }
        : meeting,
    );
  }
}
