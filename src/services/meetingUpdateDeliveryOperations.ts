import { MeetingUpdatePlanBlocked } from "./meetingUpdatePlanTypes";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pointersFor } from "../repositories/meetingUpdateDeliveryState";
import type {
  MeetingUpdateProviderOperation,
  MeetingUpdateSubmission,
} from "../types/meetingUpdateDelivery";
import { DiscordMessageHttpError } from "./discordMessageEditor";
import { meetingUpdateMessageFingerprint } from "./meetingUpdateFingerprint";
import {
  MeetingDeliveryStopped,
  MAX_CONSECUTIVE_KNOWN_FAILURES,
  type DeliveryHistory,
} from "./meetingUpdateDeliveryTypes";
import type { DeliveryContext } from "./meetingUpdateDeliveryState";
import { registeredPointers } from "./meetingUpdateDeliveryState";
import {
  observeDeliveryTarget,
  observeDeliveryDestination,
  verifyDeliveryOperation,
  assertDeliveryWriteResponse,
} from "./meetingUpdateDeliveryObserve";
import type { MeetingUpdatePayload } from "./meetingUpdatePlanTypes";

type Submitted = Extract<MeetingUpdateSubmission, { kind: "submitted" }>;
type Accepted =
  | Extract<MeetingUpdateSubmission, { kind: "returned" }>
  | (Extract<MeetingUpdateSubmission, { kind: "uncertain" }> & {
      reason: "completion_unknown";
    });
class RegistrationNotApplied extends Error {}
const definiteStatuses = new Set([400, 401, 403, 404, 405, 413, 429]);
export function providerRetryAfter(error: unknown) {
  return error instanceof DiscordMessageHttpError && error.status === 429
    ? error.retryAfterSeconds
    : undefined;
}
export function retryAt(
  ctx: DeliveryContext,
  failures: number,
  providerSeconds?: number,
) {
  const delay = Math.min(300, 5 * 2 ** Math.min(failures, 6));
  const jitter = 5 + (delay - 5) * (ctx.deps.random ?? Math.random)();
  return Math.ceil(ctx.now() + Math.max(jitter, providerSeconds ?? 0));
}
export async function retireKnownFailure(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  providerSeconds?: number,
) {
  const progress = ctx.own(row);
  const rejected = progress.operations
    .map((op) => op.submission)
    .find((submission) => submission.kind === "rejected");
  const exhausted =
    row.updateDelivery.attempts + 1 >= MAX_CONSECUTIVE_KNOWN_FAILURES;
  const next = exhausted
    ? await ctx.progress(row, { kind: "blocked", reason: "retry_exhausted" })
    : await ctx.progress(row, {
        kind: "retrying",
        reason:
          rejected?.kind === "rejected" ? rejected.reason : "not_submitted",
        nextCheckAt:
          rejected?.kind === "rejected"
            ? rejected.retryAt
            : retryAt(ctx, row.updateDelivery.attempts, providerSeconds),
      });
  return ctx.result(
    exhausted ? "blocked" : "retryable",
    next,
    "retry_exhausted",
  );
}
async function beforeMutation(
  ctx: DeliveryContext,
  operation: MeetingUpdateProviderOperation,
) {
  const row = await ctx.guard();
  if (operation.kind === "post")
    await observeDeliveryDestination(ctx, row, operation.channelId);
  if (operation.kind === "patch" || operation.kind === "delete") {
    const message = await observeDeliveryTarget(ctx, row, operation);
    if (!message) throw new MeetingUpdatePlanBlocked("missing_target");
    if (
      meetingUpdateMessageFingerprint(message) !== operation.beforeFingerprint
    )
      throw new MeetingDeliveryStopped("Target changed");
    if (
      operation.kind === "delete" &&
      (pointersFor(row).notesMessageIds.includes(operation.messageId) ||
        row.summaryMessageId === operation.messageId)
    )
      throw new MeetingDeliveryStopped("Cleanup target is registered");
  }
  return ctx.guard();
}
async function register(
  ctx: DeliveryContext,
  operation: Extract<MeetingUpdateProviderOperation, { kind: "register" }>,
) {
  return ctx.serialize(async () => {
    const row = await ctx.guard();
    const nextPointers = registeredPointers(ctx.own(row), operation);
    let applied: "applied" | "stale" | undefined;
    try {
      applied = await ctx.effect((signal) => {
        ctx.invokedWrite();
        return ctx.deps.repository.registerNotesPointers({
          key: ctx.input.key,
          expectedContentRevision: ctx.own(row).attempt.contentRevision,
          expectedDeliveryRevision: row.updateDelivery.revision,
          attemptId: ctx.own(row).attempt.attemptId,
          expectedPointers: operation.expectedPointers,
          nextPointers,
          signal,
        });
      });
    } catch {
      /* Exact pointer and claim readback is required below. */
    }
    const after = await ctx.read(true);
    ctx.own(after);
    if (!isDeepStrictEqual(ctx.own(after).operations, ctx.own(row).operations))
      throw new MeetingDeliveryStopped("Registration marker changed");
    if (!isDeepStrictEqual(pointersFor(after), nextPointers)) {
      if (applied === "stale")
        throw new RegistrationNotApplied("Pointer CAS rejected");
      throw new MeetingDeliveryStopped("Pointer acknowledgement is unproven");
    }
    return after;
  });
}
async function markRejected(
  ctx: DeliveryContext,
  index: number,
  marker: Submitted,
  reason: "not_submitted" | "provider_rejected" | "rate_limited",
  providerSeconds?: number,
) {
  const row = await ctx.read(true);
  return ctx.submission(index, {
    ...marker,
    kind: "rejected",
    rejectedAt: ctx.now(),
    retryAt: retryAt(ctx, row.updateDelivery.attempts, providerSeconds),
    reason,
  });
}
async function issueOperation(
  ctx: DeliveryContext,
  operation: MeetingUpdateProviderOperation,
  payloads: MeetingUpdatePayload[],
  marker: Submitted,
  markInvoked: () => void,
): Promise<Accepted> {
  if (operation.kind === "register") {
    markInvoked();
    await register(ctx, operation);
  } else if (operation.kind === "delete") {
    await ctx.effect((signal) => {
      signal.throwIfAborted();
      markInvoked();
      return ctx.deps.discord.deleteNotesMessage({ ...operation, signal });
    });
  } else {
    const payload = payloads.find(
      (item) => item.operationId === operation.operationId,
    );
    if (!payload)
      throw new MeetingDeliveryStopped(
        "Immutable local payload is unavailable",
      );
    const response = await ctx.effect((signal) => {
      signal.throwIfAborted();
      markInvoked();
      return ctx.deps.discord.writeNotesMessage({
        channelId: operation.channelId,
        ...(operation.kind === "patch"
          ? { messageId: operation.messageId }
          : {}),
        embeds: payload.payload.embeds,
        signal,
      });
    });
    assertDeliveryWriteResponse(response, operation);
    if (operation.kind === "post") {
      return {
        ...marker,
        kind: "returned",
        messageId: response.id,
        returnedAt: ctx.now(),
      };
    }
  }
  return { ...marker, kind: "uncertain", reason: "completion_unknown" };
}
async function recordVerifiedOperation(
  ctx: DeliveryContext,
  index: number,
  operation: MeetingUpdateProviderOperation,
  marker: Submitted,
  returnedId?: string,
) {
  const row = await ctx.read(true);
  const fingerprint = await verifyDeliveryOperation(
    ctx,
    row,
    operation,
    returnedId,
  );
  await ctx.submission(index, {
    ...marker,
    kind: "verified",
    verifiedAt: ctx.now(),
    fingerprint,
    receipt: returnedId
      ? { kind: "message", messageId: returnedId }
      : { kind: "none" },
  });
}
async function operationFailed(
  ctx: DeliveryContext,
  index: number,
  marker: Submitted,
  invoked: boolean,
  error: unknown,
) {
  if (!invoked || error instanceof RegistrationNotApplied) {
    await markRejected(
      ctx,
      index,
      marker,
      "not_submitted",
      providerRetryAfter(error),
    );
    return;
  }
  if (
    error instanceof DiscordMessageHttpError &&
    definiteStatuses.has(error.status)
  ) {
    await markRejected(
      ctx,
      index,
      marker,
      error.status === 429 ? "rate_limited" : "provider_rejected",
      error.retryAfterSeconds,
    );
    if ([401, 403, 404].includes(error.status)) {
      const row = await ctx.read(true);
      await ctx.progress(row, {
        kind: "blocked",
        reason:
          error.status === 404 ? "missing_target" : "inaccessible_destination",
      });
    }
    return;
  }
  // An issued mutation never becomes retry permission from an exception or GET.
  await ctx.submission(index, {
    ...marker,
    kind: "uncertain",
    reason: "provider_outcome_unknown",
  });
  throw error;
}
export async function executeDeliveryOperation(
  ctx: DeliveryContext,
  index: number,
  payloads: MeetingUpdatePayload[],
) {
  const prepared = await beforeMutation(ctx, ctx.attempt!.operations[index]);
  const operation = ctx.own(prepared).attempt.operations[index];
  const marker: Submitted = {
    kind: "submitted",
    submissionId: randomUUID(),
    submittedAt: ctx.now(),
  };
  // A marker ACK failure never enters the local never-invoked recovery path.
  await ctx.submission(index, marker);
  let invoked = false;
  let accepted: Accepted;
  try {
    await beforeMutation(ctx, operation);
    accepted = await issueOperation(ctx, operation, payloads, marker, () => {
      invoked = true;
    });
  } catch (error) {
    await operationFailed(ctx, index, marker, invoked, error);
    return;
  }
  // Positive acceptance is durable before independent reads; their failures cannot reject the mutation.
  await ctx.submission(index, accepted);
  await recordVerifiedOperation(
    ctx,
    index,
    operation,
    marker,
    accepted.kind === "returned" ? accepted.messageId : undefined,
  );
}
