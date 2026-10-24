import { z } from "zod";
import {
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
  presentationPartSchema,
  readMeetingUpdateRevisions,
  type PreparedMeetingUpdateAttempt,
  type MeetingUpdateProviderOperation,
  type MeetingUpdateDelivery,
} from "../types/meetingUpdateDelivery";
import { PublicationPreviewBlockedError } from "./recoveryDiscordPublicationTypes";
import {
  assertDeletableNotesLayout,
  notesPointers,
  readMeetingUpdateLayouts,
  validateMeetingUpdateEmbeds,
  type MeetingUpdateLayout,
} from "./meetingUpdateLayout";
import {
  renderNotesUpdate,
  mergeNotesUpdate,
  renderSummaryUpdate,
  batchRenderedNotesPages,
} from "./meetingUpdateRender";
import {
  meetingUpdateCreationFingerprint,
  meetingUpdateMessageFingerprint,
} from "./meetingUpdateFingerprint";
import type { EditableEmbed } from "./discordEmbedLayout";
import {
  MeetingUpdatePlanBlocked,
  type MeetingUpdatePlan,
  type MeetingUpdatePlanInput,
  type MeetingUpdatePayload,
  type MeetingUpdateTarget,
} from "./meetingUpdatePlanTypes";
export type {
  MeetingUpdatePlan,
  MeetingUpdatePlanInput,
} from "./meetingUpdatePlanTypes";
export {
  meetingUpdateCreationFingerprint,
  meetingUpdateMessageFingerprint,
  observedMeetingUpdateCreationFingerprint,
} from "./meetingUpdateFingerprint";

type Work = {
  operations: MeetingUpdateProviderOperation[];
  payloads: MeetingUpdatePayload[];
  targets: MeetingUpdateTarget[];
};
function target(
  work: Work,
  layout: MeetingUpdateLayout,
  embeds: Record<string, unknown>[],
): void {
  validateMeetingUpdateEmbeds(embeds);
  const beforeFingerprint = meetingUpdateMessageFingerprint(layout.message);
  const after = { ...layout.message, embeds };
  const desiredFingerprint = meetingUpdateMessageFingerprint(after);
  work.targets.push({
    channelId: after.channel_id,
    messageId: after.id,
    beforeFingerprint,
    desiredFingerprint,
    after,
  });
  if (beforeFingerprint === desiredFingerprint) return;
  const operationId = `patch-${work.operations.length}`;
  work.operations.push({
    kind: "patch",
    operationId,
    channelId: after.channel_id,
    messageId: after.id,
    beforeFingerprint,
    desiredFingerprint,
  });
  work.payloads.push({
    kind: "patch",
    operationId,
    payload: { embeds, allowed_mentions: { parse: [] } },
  });
}
function register(
  work: Work,
  input: MeetingUpdatePlanInput,
  slots: Extract<MeetingUpdateProviderOperation, { kind: "register" }>["slots"],
): void {
  const expectedPointers = notesPointers(input);
  if (!expectedPointers.notesChannelId)
    throw new MeetingUpdatePlanBlocked("missing_target");
  work.operations.push({
    kind: "register",
    operationId: `register-${work.operations.length}`,
    expectedPointers,
    notesChannelId: expectedPointers.notesChannelId,
    slots,
  });
}
function cleanup(work: Work, layout: MeetingUpdateLayout): void {
  assertDeletableNotesLayout(layout);
  work.operations.push({
    kind: "delete",
    operationId: `delete-${work.operations.length}`,
    channelId: layout.message.channel_id,
    messageId: layout.message.id,
    beforeFingerprint: meetingUpdateMessageFingerprint(layout.message),
  });
}
function planNotes(
  work: Work,
  input: MeetingUpdatePlanInput,
  captured: PreparedMeetingUpdateAttempt["capturedParts"],
  layouts: MeetingUpdateLayout[],
  retained: MeetingUpdateLayout[],
): void {
  const requested =
    captured.notesBody || captured.notesTitle || captured.notesWarning;
  const planned = requested
    ? planExistingNotes(
        work,
        layouts,
        renderNotesUpdate(input.history, captured, layouts),
      )
    : planUnchangedNotes(work, layouts);
  const { slots, obsolete, remaining } = planned;
  addNotesPages(work, input, slots, remaining);
  const current = notesPointers(input);
  const changed =
    slots.length !== current.notesMessageIds.length ||
    slots.some(
      (slot, index) =>
        slot.kind !== "existing" ||
        slot.messageId !== current.notesMessageIds[index],
    );
  const registeredCandidates =
    input.history.updateDelivery?.createdCandidates.some((candidate) =>
      current.notesMessageIds.includes(candidate.messageId),
    );
  if (changed || retained.length || registeredCandidates)
    register(work, input, slots);
  for (const layout of [...obsolete, ...retained]) cleanup(work, layout);
}
type PlannedNotes = {
  slots: Extract<MeetingUpdateProviderOperation, { kind: "register" }>["slots"];
  obsolete: MeetingUpdateLayout[];
  remaining: EditableEmbed[];
};
function mergeNotesPost(
  layout: MeetingUpdateLayout,
  rendered: EditableEmbed[],
  firstPage: number,
) {
  const after: Record<string, unknown>[] = [];
  const unrelated = layout.message.embeds.filter(
    (_, index) => !layout.notesSlots.includes(index),
  );
  const assigned: Record<string, unknown>[] = [];
  let page = firstPage;
  let full = false;
  for (const [index, embed] of layout.message.embeds.entries()) {
    if (!layout.notesSlots.includes(index)) {
      after.push(embed);
      continue;
    }
    const candidate = rendered[page];
    if (!candidate || full) continue;
    const merged = mergeNotesUpdate(embed, candidate);
    if (!notesMessageFits([...unrelated, ...assigned, merged])) {
      if (!assigned.length)
        throw new MeetingUpdatePlanBlocked("unsupported_layout");
      full = true;
      continue;
    }
    after.push(merged);
    assigned.push(merged);
    page++;
  }
  const used = assigned.length;
  return { after, used, page };
}
function notesMessageFits(embeds: Record<string, unknown>[]): boolean {
  try {
    validateMeetingUpdateEmbeds(embeds);
    return true;
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      error instanceof PublicationPreviewBlockedError
    )
      return false;
    throw error;
  }
}
function planExistingNotes(
  work: Work,
  layouts: MeetingUpdateLayout[],
  rendered: EditableEmbed[],
): PlannedNotes {
  const planned: PlannedNotes = { slots: [], obsolete: [], remaining: [] };
  let page = 0;
  for (const layout of layouts) {
    const merged = mergeNotesPost(layout, rendered, page);
    page = merged.page;
    if (merged.used) {
      planned.slots.push({ kind: "existing", messageId: layout.message.id });
      target(work, layout, merged.after);
    } else planned.obsolete.push(layout);
  }
  planned.remaining = rendered.slice(page);
  return planned;
}
function planUnchangedNotes(
  work: Work,
  layouts: MeetingUpdateLayout[],
): PlannedNotes {
  const slots: PlannedNotes["slots"] = [];
  for (const layout of layouts) {
    slots.push({ kind: "existing", messageId: layout.message.id });
    target(work, layout, layout.message.embeds);
  }
  return { slots, obsolete: [], remaining: [] };
}
function addNotesPages(
  work: Work,
  input: MeetingUpdatePlanInput,
  slots: Extract<MeetingUpdateProviderOperation, { kind: "register" }>["slots"],
  remaining: EditableEmbed[],
): void {
  if (!remaining.length) return;
  const current = notesPointers(input);
  if (!current.notesChannelId || !current.notesMessageIds.length)
    throw new MeetingUpdatePlanBlocked("missing_target");
  const channelId = current.notesChannelId;
  for (const batch of batchRenderedNotesPages(remaining)) {
    validateMeetingUpdateEmbeds(batch);
    const operationId = `post-${work.operations.length}`;
    work.operations.push({
      kind: "post",
      operationId,
      channelId,
      desiredFingerprint: meetingUpdateCreationFingerprint({
        channelId,
        botId: input.botId,
        embeds: batch,
      }),
    });
    work.payloads.push({
      kind: "post",
      operationId,
      payload: { embeds: batch, allowed_mentions: { parse: [] } },
    });
    slots.push({ kind: "created", operationId });
  }
}
function idleMeetingUpdate(delivery: MeetingUpdateDelivery): MeetingUpdatePlan {
  if (delivery.createdCandidates.length || delivery.cleanupCandidates.length)
    throw new MeetingUpdatePlanBlocked("retained_work_without_requested_parts");
  return { kind: "idle" };
}
export function planMeetingUpdate(
  input: MeetingUpdatePlanInput,
): MeetingUpdatePlan {
  try {
    const delivery = meetingUpdateDeliverySchema.parse(
      input.history.updateDelivery,
    );
    if (delivery.policy.kind !== "active")
      throw new MeetingUpdatePlanBlocked("publication_held");
    if ("attempt" in delivery.progress)
      throw new MeetingUpdatePlanBlocked("attempt_retained");
    const capturedParts: PreparedMeetingUpdateAttempt["capturedParts"] = {};
    for (const part of presentationPartSchema.options)
      if (delivery.parts[part].desired > delivery.parts[part].acknowledged)
        capturedParts[part] = delivery.parts[part].desired;
    if (!Object.keys(capturedParts).length) return idleMeetingUpdate(delivery);
    const layouts = readMeetingUpdateLayouts(input);
    if (
      (capturedParts.summaryBody ||
        capturedParts.summaryTitle ||
        capturedParts.summaryWarning) &&
      !layouts.summary
    )
      throw new MeetingUpdatePlanBlocked("missing_target");
    const work: Work = { operations: [], payloads: [], targets: [] };
    planNotes(work, input, capturedParts, layouts.notes, layouts.retained);
    if (layouts.summary)
      target(
        work,
        layouts.summary,
        renderSummaryUpdate(input.history, capturedParts, layouts.summary),
      );
    const attempt = preparedMeetingUpdateAttemptSchema.parse({
      attemptId: input.attemptId,
      contentRevision: readMeetingUpdateRevisions(input.history)
        .contentRevision,
      capturedParts,
      expectedPointers: notesPointers(input),
      operations: work.operations,
      observations: work.targets.map((target) => ({
        channelId: target.channelId,
        messageId: target.messageId,
        fingerprint: target.beforeFingerprint,
        observedAt: input.observedAt,
      })),
    });
    // Schema admission also reserves retained cleanup capacity before any provider effect.
    meetingUpdateDeliverySchema.parse({
      ...delivery,
      progress: {
        kind: "running",
        attempt,
        claim: {
          ownerInstanceId: "planner-preflight",
          leaseExpiresAt: input.observedAt + 1,
        },
        nextCheckAt: input.observedAt,
        operations: attempt.operations.map((operation) => ({
          operationId: operation.operationId,
          submission: { kind: "prepared" },
        })),
      },
    });
    return {
      kind: "ready",
      attempt,
      targets: work.targets,
      payloads: work.payloads,
    };
  } catch (error) {
    if (error instanceof MeetingUpdatePlanBlocked)
      return { kind: "blocked", reason: error.message };
    if (
      error instanceof z.ZodError ||
      error instanceof PublicationPreviewBlockedError
    )
      return { kind: "blocked", reason: "unsupported_layout" };
    throw error;
  }
}
