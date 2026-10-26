import { randomUUID } from "node:crypto";
import { readMeetingUpdateRevisions } from "../types/meetingUpdateDelivery";
import {
  createDeliveryContext,
  type DeliveryContext,
} from "./meetingUpdateDeliveryState";
import {
  gatherDeliveryTargets,
  observeUncertainDelivery,
  verifyDeliveryObservations,
  verifyDeliveryOperation,
} from "./meetingUpdateDeliveryObserve";
import {
  executeDeliveryOperation,
  retireKnownFailure,
  retryAt,
  providerRetryAfter,
} from "./meetingUpdateDeliveryOperations";
import { planMeetingUpdate } from "./meetingUpdatePlan";
import { MeetingUpdatePlanBlocked } from "./meetingUpdatePlanTypes";
import { DiscordMessageHttpError } from "./discordMessageEditor";
import {
  MAX_CONSECUTIVE_KNOWN_FAILURES,
  MeetingDeliveryStopped,
} from "./meetingUpdateDeliveryTypes";
import type {
  DeliveryHistory,
  MeetingDeliveryDependencies,
  MeetingDeliveryRunInput,
  MeetingDeliveryRunResult,
} from "./meetingUpdateDeliveryTypes";
export type {
  MeetingDeliveryRunResult,
  MeetingDeliveryRunInput,
  MeetingDeliveryDurableOutcome,
} from "./meetingUpdateDeliveryTypes";
export { MAX_CONSECUTIVE_KNOWN_FAILURES } from "./meetingUpdateDeliveryTypes";

function allSettled(ctx: DeliveryContext, row: DeliveryHistory) {
  return ctx
    .own(row)
    .operations.every((op) =>
      ["prepared", "verified", "rejected"].includes(op.submission.kind),
    );
}
async function retireSuperseded(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  providerSeconds = 0,
) {
  const nextCheckAt = Math.max(
    ctx.now() + Math.ceil(providerSeconds),
    ...ctx
      .own(row)
      .operations.map((operation) =>
        operation.submission.kind === "rejected"
          ? operation.submission.retryAt
          : 0,
      ),
  );
  return ctx.result(
    "superseded",
    await ctx.progress(row, { kind: "pending", nextCheckAt }),
  );
}
async function finish(ctx: DeliveryContext) {
  const row = await ctx.read(true);
  const progress = ctx.own(row);
  if (!allSettled(ctx, row)) return hold(ctx, row);
  if (
    readMeetingUpdateRevisions(row).contentRevision !==
      progress.attempt.contentRevision &&
    !progress.operations.some(
      (op) =>
        op.submission.kind === "rejected" &&
        op.submission.reason !== "not_submitted",
    ) &&
    progress.operations.some((op) => op.submission.kind !== "verified")
  )
    return retireSuperseded(ctx, row);
  if (progress.operations.some((op) => op.submission.kind === "rejected"))
    return retireKnownFailure(ctx, row);
  if (progress.operations.some((op) => op.submission.kind === "prepared"))
    return retireSuperseded(ctx, row);
  for (const [index, operation] of progress.attempt.operations.entries()) {
    const result = progress.operations[index].submission;
    await verifyDeliveryOperation(
      ctx,
      row,
      operation,
      result.kind === "verified" && result.receipt.kind === "message"
        ? result.receipt.messageId
        : undefined,
    );
  }
  await verifyDeliveryObservations(ctx, row);
  const latest = await ctx.read(true);
  ctx.own(latest);
  ctx.assertPointers(latest);
  const completed = await ctx.change(latest, {
    kind: "complete",
    revision: randomUUID(),
    attemptId: progress.attempt.attemptId,
    completedAt: ctx.now(),
  });
  return ctx.result("settled", completed);
}
async function hold(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  providerSeconds?: number,
) {
  const progress = ctx.own(row);
  const { nextCheckAt: _unused, ...retained } =
    progress.kind === "uncertain" ? { ...progress, nextCheckAt: 0 } : progress;
  void _unused;
  const hasUnknown = progress.operations.some(
    (op) =>
      op.submission.kind === "submitted" ||
      (op.submission.kind === "uncertain" &&
        op.submission.reason === "provider_outcome_unknown"),
  );
  const after = await ctx.progress(
    row,
    hasUnknown
      ? { ...retained, kind: "uncertain", reason: "provider_outcome_unknown" }
      : {
          ...retained,
          kind: "reconciling",
          nextCheckAt: Math.max(
            progress.claim.leaseExpiresAt,
            "nextCheckAt" in progress ? progress.nextCheckAt : 0,
            retryAt(ctx, row.updateDelivery.attempts, providerSeconds),
          ),
        },
  );
  return {
    ...ctx.result("uncertain", after),
    observations: hasUnknown ? await observeUncertainDelivery(ctx, after) : [],
  };
}
async function reconcileClaimed(ctx: DeliveryContext) {
  let row = await ctx.read(true);
  const progress = ctx.own(row);
  for (const [index, operation] of progress.attempt.operations.entries()) {
    const submission = progress.operations[index].submission;
    const returned =
      submission.kind === "returned" && operation.kind === "post";
    const accepted =
      submission.kind === "uncertain" &&
      submission.reason === "completion_unknown";
    if (!returned && !accepted) continue;
    const fingerprint = await verifyDeliveryOperation(
      ctx,
      row,
      operation,
      submission.kind === "returned" ? submission.messageId : undefined,
    );
    row = await ctx.submission(index, {
      kind: "verified",
      submissionId: submission.submissionId,
      submittedAt: submission.submittedAt,
      verifiedAt: ctx.now(),
      fingerprint,
      receipt:
        submission.kind === "returned"
          ? { kind: "message", messageId: submission.messageId }
          : { kind: "none" },
    });
  }
  return finish(ctx);
}
async function acquireRetained(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  reconcile: boolean,
) {
  const retained = row.updateDelivery.progress;
  if (!("attempt" in retained)) throw new Error("Expected retained attempt");
  if (retained.kind === "uncertain") {
    const observations = reconcile
      ? await observeUncertainDelivery(ctx, row)
      : [];
    return { ...ctx.result("uncertain", await ctx.read()), observations };
  }
  const authority = await ctx.input.work.authority();
  const result = await ctx.acquireAttempt(row, retained.attempt, authority);
  if (result !== "claimed") return ctx.result("superseded", await ctx.read());
  const claimed = await ctx.read();
  ctx.capture(claimed, retained.attempt, authority);
  ctx.startRenewals();
  return reconcileClaimed(ctx);
}
async function acquireFresh(ctx: DeliveryContext, row: DeliveryHistory) {
  const snapshot = await gatherDeliveryTargets(ctx, row);
  ctx.selectBotId(snapshot.botId);
  const plan = planMeetingUpdate({
    history: row,
    attemptId: randomUUID(),
    observedAt: ctx.now(),
    ...snapshot,
  });
  if (plan.kind === "idle") return ctx.result("settled", row);
  if (plan.kind === "blocked") throw new MeetingUpdatePlanBlocked(plan.reason);
  const authority = await ctx.input.work.authority();
  const claimed = await ctx.acquireAttempt(row, plan.attempt, authority);
  if (claimed !== "claimed") return ctx.result("superseded", await ctx.read());
  const exact = await ctx.read();
  ctx.capture(exact, plan.attempt, authority);
  ctx.startRenewals();
  for (let index = 0; index < plan.attempt.operations.length; index++) {
    await executeDeliveryOperation(ctx, index, plan.payloads);
    const current = await ctx.read(true);
    if (!("attempt" in current.updateDelivery.progress))
      return ctx.result("blocked", current, "inaccessible_destination");
    if (ctx.own(current).operations[index].submission.kind !== "verified")
      return finish(ctx);
  }
  return finish(ctx);
}
async function acquire(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  reconcile: boolean,
) {
  const retained = row.updateDelivery.progress;
  if (retained.kind === "blocked")
    return ctx.result("blocked", row, retained.reason);
  if (retained.kind === "synced") return ctx.result("settled", row);
  if ("nextCheckAt" in retained && retained.nextCheckAt > ctx.now())
    return ctx.result(
      retained.kind === "retrying" ? "retryable" : "superseded",
      row,
    );
  if ("attempt" in retained) return acquireRetained(ctx, row, reconcile);
  if (reconcile) return ctx.result("superseded", row);
  return acquireFresh(ctx, row);
}
function planFailureReason(error: MeetingUpdatePlanBlocked) {
  if (error.message === "missing_target") return "missing_target" as const;
  if (error.message === "inaccessible_destination")
    return "inaccessible_destination" as const;
  return "unsupported_layout" as const;
}
async function claimedFailure(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  error: unknown,
) {
  const progress = ctx.own(row);
  if (!allSettled(ctx, row)) return hold(ctx, row, providerRetryAfter(error));
  if (
    readMeetingUpdateRevisions(row).contentRevision !==
      progress.attempt.contentRevision ||
    row.updateDelivery.policy.kind !== "active"
  )
    return retireSuperseded(ctx, row, providerRetryAfter(error));
  if (error instanceof MeetingUpdatePlanBlocked)
    return ctx.result(
      "blocked",
      await ctx.progress(row, {
        kind: "blocked",
        reason: planFailureReason(error),
      }),
      error.message,
    );
  if (
    error instanceof MeetingDeliveryStopped ||
    ctx.input.work.signal.aborted ||
    ctx.input.signal?.aborted
  )
    return retireSuperseded(ctx, row, providerRetryAfter(error));
  return retireKnownFailure(ctx, row, providerRetryAfter(error));
}
function preflightBlockReason(error: unknown) {
  if (error instanceof DiscordMessageHttpError)
    return error.status === 404
      ? ("missing_target" as const)
      : ("inaccessible_destination" as const);
  return error instanceof MeetingUpdatePlanBlocked &&
    error.message === "missing_target"
    ? ("missing_target" as const)
    : ("unsupported_layout" as const);
}
async function preflightFailure(
  ctx: DeliveryContext,
  row: DeliveryHistory,
  error: unknown,
) {
  if ("attempt" in row.updateDelivery.progress) return ctx.result("uncertain");
  if (
    error instanceof MeetingUpdatePlanBlocked ||
    (error instanceof DiscordMessageHttpError &&
      [401, 403, 404].includes(error.status))
  ) {
    const reason = preflightBlockReason(error);
    return ctx.result(
      "blocked",
      await ctx.progress(row, { kind: "blocked", reason }),
      reason,
    );
  }
  const exhausted =
    row.updateDelivery.attempts + 1 >= MAX_CONSECUTIVE_KNOWN_FAILURES;
  const next = await ctx.progress(
    row,
    exhausted
      ? { kind: "blocked", reason: "retry_exhausted" }
      : {
          kind: "retrying",
          reason: "not_submitted",
          nextCheckAt: retryAt(
            ctx,
            row.updateDelivery.attempts,
            providerRetryAfter(error),
          ),
        },
  );
  return ctx.result(
    exhausted ? "blocked" : "retryable",
    next,
    "retry_exhausted",
  );
}
async function failed(
  ctx: DeliveryContext,
  error: unknown,
): Promise<MeetingDeliveryRunResult> {
  try {
    const row = await ctx.read(true);
    return await (ctx.claim
      ? claimedFailure(ctx, row, error)
      : preflightFailure(ctx, row, error));
  } catch {
    return ctx.result("uncertain");
  }
}
export function createMeetingUpdateDeliveryService(
  deps: MeetingDeliveryDependencies,
) {
  async function run(
    input: MeetingDeliveryRunInput,
    reconcile: boolean,
  ): Promise<MeetingDeliveryRunResult> {
    const ctx = createDeliveryContext(deps, input);
    let result: MeetingDeliveryRunResult;
    try {
      const row = await ctx.read();
      if (
        row.updateDelivery.policy.kind !== "active" &&
        !("attempt" in row.updateDelivery.progress)
      )
        result = ctx.result("blocked", row, "publication_held");
      else result = await acquire(ctx, row, reconcile);
    } catch (error) {
      result = await failed(ctx, error);
    }
    const renewed = await ctx.stopRenewals();
    if (!renewed) return ctx.result("uncertain");
    if (!result.durable) return result;
    try {
      const latest = await ctx.read(true);
      return {
        ...result,
        durable: {
          deliveryRevision: latest.updateDelivery.revision,
          claim: ctx.claim,
        },
      };
    } catch {
      return ctx.result("uncertain");
    }
  }
  return {
    deliverMeetingUpdate: (input: MeetingDeliveryRunInput) => run(input, false),
    reconcileMeetingUpdate: (input: MeetingDeliveryRunInput) =>
      run(input, true),
  };
}

export async function deliverMeetingUpdate(
  input: MeetingDeliveryRunInput,
): Promise<MeetingDeliveryRunResult> {
  const { configuredMeetingUpdateDelivery } =
    await import("./meetingUpdateDeliveryConfigured");
  return configuredMeetingUpdateDelivery.deliverMeetingUpdate(input);
}
export async function reconcileMeetingUpdate(
  input: MeetingDeliveryRunInput,
): Promise<MeetingDeliveryRunResult> {
  const { configuredMeetingUpdateDelivery } =
    await import("./meetingUpdateDeliveryConfigured");
  return configuredMeetingUpdateDelivery.reconcileMeetingUpdate(input);
}
