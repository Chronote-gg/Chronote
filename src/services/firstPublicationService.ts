import type { BatchAcquisition } from "../repositories/firstPublicationRepository";
import { randomUUID } from "node:crypto";
import {
  planSchema,
  digest,
  type FirstPublicationPlan,
  type FirstPublicationDependencies,
  type FirstPublicationReceipt,
  type PublicationResult,
  type PublicationPage,
} from "./firstPublicationTypes";
import {
  firstPublicationDigest,
  renderFirstPublication,
  verifyFirstPublicationMessage,
  verifyPublishedReceipt,
} from "./firstPublicationPlan";
import { firstPublicationSnapshot } from "./firstPublicationSource";
import { DiscordMessageHttpError } from "./discordMessageEditor";
const definite = new Set([400, 401, 403, 404, 405, 413, 429]);
type Ready = Extract<
  FirstPublicationPlan["meetings"][number],
  { outcome: "ready" }
>;
async function assertLive(
  m: Ready,
  deps: FirstPublicationDependencies,
  receipt?: FirstPublicationReceipt,
) {
  const row = await deps.repository.getStrong(m.key);
  if (!row || row.archivedAt)
    throw Error("Source or archive state changed; refresh preview");
  const snapshot = firstPublicationSnapshot(row);
  if (receipt) {
    assertReceiptOwner(row, receipt);
    if (m.binding.snapshot.publicationRepair === undefined)
      delete snapshot.publicationRepair;
    else snapshot.publicationRepair = m.binding.snapshot.publicationRepair;
  }
  if (
    digest(snapshot) !== m.binding.sourceDigest ||
    digest(renderFirstPublication(row)) !== digest(m.binding.payloads) ||
    (await deps.targetActive(m.key, row.meetingId))
  )
    throw Error("Source changed; refresh preview");
  const [bot, destination, runtime] = await Promise.all([
    deps.discord.getBotIdentity(),
    deps.discord.inspectDestination(m.key.guildId, m.binding.channelId),
    deps.runtime(),
  ]);
  if (
    bot.id !== m.binding.botId ||
    !destination.allowed ||
    runtime.kind !== "compatible"
  )
    throw Error(
      destination.reason ??
        "Runtime or destination unavailable; refresh preview",
    );
  return runtime;
}
function noSend(r: FirstPublicationReceipt) {
  return r.pages.every((p) => p.kind === "prepared" || p.kind === "rejected");
}
function outcome(r: FirstPublicationReceipt): "partial" | "uncertain" {
  return r.pages.some((p) => p.kind === "submitted" || p.kind === "uncertain")
    ? "uncertain"
    : "partial";
}
async function setPage(
  r: FirstPublicationReceipt,
  index: number,
  page: PublicationPage,
  deps: FirstPublicationDependencies,
) {
  const after = {
    ...r,
    pages: r.pages.map((p, i) => (i === index ? page : p)),
    updatedAt: deps.now(),
  };
  if ((await deps.repository.recordPage(r, after)) !== "applied")
    throw Error("Publication receipt acknowledgement unknown; reconcile");
  return after;
}
async function sendMeeting(
  m: Ready,
  initial: FirstPublicationReceipt,
  deps: FirstPublicationDependencies,
) {
  let r = initial;
  for (const [index, page] of r.pages.entries()) {
    const sent = await sendPage(m, r, index, page, deps);
    r = sent.receipt;
    if (!sent.completed) return sent;
  }

  if (
    (await deps.repository.settleVerified(r, m.binding.snapshot)) !== "applied"
  )
    throw Error("Registration not verified; reconcile");
  const row = await deps.repository.getStrong(m.key),
    receipt = await deps.repository.readAttempt(r.authority);
  if (!row || !receipt)
    throw Error("Registration readback unavailable; reconcile");
  await verifyPublishedReceipt(receipt, row, deps);
  return { receipt, completed: true };
}
export async function applyFirstPublication(
  input: FirstPublicationPlan,
  expectedDigest: string,
  deps: FirstPublicationDependencies,
): Promise<PublicationResult> {
  const plan = planSchema.parse(input);
  if (
    !plan.ready ||
    plan.digest !== expectedDigest ||
    firstPublicationDigest(plan) !== expectedDigest ||
    digest(plan.profile) !== digest(deps.profile)
  )
    throw Error("Invalid approved plan or profile");
  if ((await deps.identity()) !== plan.profile.accountId)
    throw Error("AWS account mismatch");
  if (plan.operation !== "publish") return applyResolution(plan, deps);
  const batch = await claimPublicationBatch(plan, deps);
  if (!batch.claimed) return batch.result;
  return publishBatch(batch.ready, batch.entries, deps, batch.result);
}
async function claimPublicationBatch(
  plan: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
) {
  const result: PublicationResult = { meetings: [] },
    ready: Ready[] = [],
    entries: BatchAcquisition["entries"] = [];
  const runId = randomUUID();
  let runtime;
  try {
    for (const m of plan.meetings) {
      if (m.outcome === "skipped_archived") {
        result.meetings.push({ key: m.key, outcome: "skipped_archived" });
        continue;
      }
      if (m.outcome === "blocked") throw Error(m.reason);
      const checked = await preflightPublication(m, plan, runId, deps);
      if (checked.done) {
        result.meetings.push(checked.done);
        continue;
      }
      if (m.outcome !== "ready")
        throw Error("Prior publication changed; reconcile");
      runtime = checked.runtime;
      ready.push(m);
      entries.push(checked.entry);
    }
    if (!entries.length) return { claimed: false as const, result };
    if (
      !runtime ||
      (await deps.repository.acquireBatch({ entries, runtime })) !== "owned"
    )
      throw Error("Publication claim changed; refresh preview");
  } catch (e) {
    appendPreflightFailure(plan, result, e);
    return { claimed: false as const, result };
  }
  return { claimed: true as const, ready, entries, result };
}
async function publishBatch(
  ready: Ready[],
  entries: BatchAcquisition["entries"],
  deps: FirstPublicationDependencies,
  result: PublicationResult,
) {
  for (const [i, m] of ready.entries()) {
    try {
      const r = await sendMeeting(m, entries[i].receipt, deps);
      if (r.completed)
        result.meetings.push({
          key: m.key,
          outcome: "verified",
          messageIds: r.receipt.pages.flatMap((p) =>
            p.kind === "verified" ? [p.messageId] : [],
          ),
        });
      else {
        result.meetings.push({
          key: m.key,
          outcome: noSend(r.receipt) ? "unsent" : outcome(r.receipt),
          reason: "Delivery stopped; run reconcile",
        });
        await retireUnstarted(
          ready.slice(i + 1),
          entries.slice(i + 1),
          deps,
          result,
        );
        break;
      }
    } catch {
      const current = await deps.repository.readAttempt(m.binding.authority);
      result.meetings.push({
        key: m.key,
        outcome: current ? outcome(current) : "uncertain",
        reason: "Publication or registration uncertain; run reconcile",
      });
      await retireUnstarted(
        ready.slice(i + 1),
        entries.slice(i + 1),
        deps,
        result,
      );
      break;
    }
  }
  return result;
}
async function retireUnstarted(
  ready: Ready[],
  entries: BatchAcquisition["entries"],
  deps: FirstPublicationDependencies,
  result: PublicationResult,
) {
  for (const [i, m] of ready.entries()) {
    try {
      const r = await deps.repository.readAttempt(m.binding.authority);
      if (r && noSend(r))
        await deps.repository.settleUnsent(r, entries[i].snapshot);
    } catch {
      /* Retain durable authority on an uncertain cleanup acknowledgement. */
    }
    result.meetings.push({
      key: m.key,
      outcome: "unsent",
      reason: "Batch stopped before this meeting; refresh preview",
    });
  }
}
type Inspection = {
  result: PublicationResult;
  resolutions: Array<{
    meeting: Ready;
    receipt: FirstPublicationReceipt;
    pages: PublicationPage[];
    operation: "finalize" | "release" | "continue";
    stoppedEvidence: string;
  }>;
};
async function inspect(
  plan: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
): Promise<Inspection> {
  if (
    firstPublicationDigest(plan) !== plan.digest ||
    digest(plan.profile) !== digest(deps.profile) ||
    (await deps.identity()) !== plan.profile.accountId
  )
    throw Error("Invalid plan identity");
  const result: PublicationResult = { meetings: [] },
    resolutions: Inspection["resolutions"] = [];
  for (const m of plan.meetings) {
    const checked = await inspectMeeting(m, deps);
    result.meetings.push(...checked.result.meetings);
    resolutions.push(...checked.resolutions);
  }
  return { result, resolutions };
}
export async function statusFirstPublication(
  input: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
): Promise<PublicationResult> {
  return (await inspect(planSchema.parse(input), deps)).result;
}
export async function reconcileFirstPublication(
  input: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
): Promise<{
  result: PublicationResult;
  resolution: FirstPublicationPlan | null;
}> {
  const original = planSchema.parse(input),
    state = await inspect(original, deps),
    operation = state.resolutions[0]?.operation;
  if (!operation) return { result: state.result, resolution: null };
  const selected = state.resolutions.filter((r) => r.operation === operation);
  const plan: FirstPublicationPlan = {
    ...original,
    operation,
    createdAt: deps.now(),
    ready: true,
    meetings: selected.map((r) => r.meeting),
    resolution: selected.map((r) => ({
      authority: r.receipt.authority,
      receiptDigest: digest(r.receipt),
      stoppedEvidence: r.stoppedEvidence,
    })),
    digest: "",
  };
  plan.digest = firstPublicationDigest(plan);
  return { result: state.result, resolution: planSchema.parse(plan) };
}
async function applyResolution(
  plan: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
): Promise<PublicationResult> {
  const state = await inspect(plan, deps),
    result: PublicationResult = { meetings: [] };
  // Preflight every resolution before the first conditional mutation.
  const selected: Inspection["resolutions"] = [];
  for (const m of plan.meetings) {
    const checked = await preflightResolution(m, plan, state, deps);
    if ("done" in checked) result.meetings.push(checked.done);
    else selected.push(checked.current);
  }
  for (const r of selected)
    result.meetings.push(await executeResolution(r, plan, deps));
  return result;
}
async function executeResolution(
  r: Inspection["resolutions"][number],
  plan: FirstPublicationPlan,
  deps: FirstPublicationDependencies,
) {
  let receipt: FirstPublicationReceipt = {
    ...r.receipt,
    processId: deps.processId,
    updatedAt: deps.now(),
    resolutionDigests: [...(r.receipt.resolutionDigests ?? []), plan.digest],
  };
  if (
    (await deps.repository.transferStoppedRun(
      r.receipt,
      receipt,
      r.meeting.binding.snapshot,
    )) !== "owned"
  )
    throw Error("Resolution owner changed");
  for (const [i, page] of r.pages.entries()) {
    if (page.kind === "verified" && receipt.pages[i].kind !== "verified")
      receipt = await setPage(receipt, i, page, deps);
  }
  if (plan.operation === "continue") {
    const sent = await sendMeeting(r.meeting, receipt, deps);
    return {
      key: r.meeting.key,
      outcome: sent.completed ? ("verified" as const) : outcome(sent.receipt),
    };
  } else {
    const settled =
      plan.operation === "finalize"
        ? await deps.repository.settleVerified(
            receipt,
            r.meeting.binding.snapshot,
          )
        : await deps.repository.settleUnsent(
            receipt,
            r.meeting.binding.snapshot,
          );
    if (settled !== "applied")
      throw Error("Resolution settlement uncertain; rerun status");
    return {
      key: r.meeting.key,
      outcome:
        plan.operation === "finalize"
          ? ("verified" as const)
          : ("unsent" as const),
    };
  }
}

function assertReceiptOwner(
  row: import("../types/db").MeetingHistory,
  receipt: FirstPublicationReceipt,
) {
  if (
    row.publicationRepair?.kind !== "running" ||
    row.publicationRepair.runId !== receipt.runId ||
    row.publicationRepair.previewDigest !== receipt.planDigest ||
    row.publicationRepair.snapshot !== receipt.sourceDigest
  )
    throw Error("Publication authority changed");
}
async function sendPage(
  m: Ready,
  r: FirstPublicationReceipt,
  index: number,
  page: PublicationPage,
  deps: FirstPublicationDependencies,
) {
  if (page.kind === "verified") {
    const message = await deps.discord.getMessage(r.channelId, page.messageId);
    verifyFirstPublicationMessage(
      message,
      r.payloads[index],
      r.channelId,
      r.botId,
    );
    return { receipt: r, completed: true };
  }
  if (page.kind !== "prepared" && page.kind !== "rejected")
    throw Error("Uncertain submission; reconcile");
  await assertLive(m, deps, r);
  r = await setPage(r, index, { kind: "submitted", at: deps.now() }, deps);
  // Nothing that can initiate another operation runs between intent and this POST.
  let message;
  try {
    message = await deps.discord.createNotesMessage({
      channelId: r.channelId,
      payload: r.payloads[index],
    });
  } catch (e) {
    if (e instanceof DiscordMessageHttpError && definite.has(e.status)) {
      r = await setPage(
        r,
        index,
        { kind: "rejected", at: deps.now(), status: e.status },
        deps,
      );
      if (noSend(r)) await deps.repository.settleUnsent(r, m.binding.snapshot);
      return { receipt: r, completed: false };
    }
    r = await setPage(r, index, { kind: "uncertain", at: deps.now() }, deps);
    return { receipt: r, completed: false };
  }
  const id = message.id;
  // Save a returned ID before the GET so a read failure remains reconcilable.
  r = await setPage(
    r,
    index,
    { kind: "uncertain", at: deps.now(), messageId: id },
    deps,
  );
  const read = await deps.discord.getMessage(r.channelId, id);
  const fingerprint = verifyFirstPublicationMessage(
    read,
    r.payloads[index],
    r.channelId,
    r.botId,
  );
  r = await setPage(
    r,
    index,
    { kind: "verified", at: deps.now(), messageId: id, fingerprint },
    deps,
  );

  return { receipt: r, completed: true };
}
async function preflightPublication(
  m: Exclude<
    FirstPublicationPlan["meetings"][number],
    { outcome: "skipped_archived" } | { outcome: "blocked" }
  >,
  plan: FirstPublicationPlan,
  runId: string,
  deps: FirstPublicationDependencies,
): Promise<
  | {
      done: PublicationResult["meetings"][number];
      runtime?: never;
      entry?: never;
    }
  | {
      done?: never;
      runtime: Extract<
        Awaited<ReturnType<FirstPublicationDependencies["runtime"]>>,
        { kind: "compatible" }
      >;
      entry: {
        snapshot: Record<string, unknown>;
        receipt: FirstPublicationReceipt;
      };
    }
> {
  const prior = await deps.repository.readAttempt(m.binding.authority),
    row = await deps.repository.getStrong(m.key);
  if (prior?.outcome === "verified" && row) {
    const ids = await verifyPublishedReceipt(prior, row, deps);
    return {
      done: {
        key: m.key,
        outcome: "already_published",
        messageIds: ids,
      },
    };
  }
  if (m.outcome === "already_published")
    throw Error("Prior publication changed; reconcile");
  if (prior?.ownerState === "running")
    throw Error("Publication unresolved; use reconcile");
  const runtime = await assertLive(m, deps);
  if (
    (await deps.discord.duplicateEvidence(m.key, m.binding.channelId)).ambiguous
  )
    throw Error("Ambiguous duplicate; reconcile");
  return {
    runtime,
    entry: {
      snapshot: m.binding.snapshot,
      receipt: {
        schemaVersion: 1,
        runId,
        generation: (prior?.generation ?? 0) + 1,
        authority: m.binding.authority,
        key: m.key,
        planDigest: plan.digest,
        sourceDigest: m.binding.sourceDigest,
        channelId: m.binding.channelId,
        botId: m.binding.botId,
        payloads: m.binding.payloads,
        pages: m.binding.payloads.map(() => ({ kind: "prepared" })),
        ownerState: "running",
        outcome: "pending",
        updatedAt: deps.now(),
        processId: deps.processId,
      },
    },
  };
}
async function inspectMeeting(
  m: FirstPublicationPlan["meetings"][number],
  deps: FirstPublicationDependencies,
): Promise<Inspection> {
  const result: PublicationResult = { meetings: [] },
    resolutions: Inspection["resolutions"] = [];

  if (m.outcome === "skipped_archived") {
    result.meetings.push({ key: m.key, outcome: "skipped_archived" });
    return { result, resolutions };
  }
  if (m.outcome === "blocked") {
    result.meetings.push({
      key: m.key,
      outcome: "blocked",
      reason: m.reason,
    });
    return { result, resolutions };
  }
  try {
    const row = await deps.repository.getStrong(m.key),
      r = await deps.repository.readAttempt(m.binding.authority);
    if (!row) throw Error("Meeting missing");
    if (!r) {
      result.meetings.push({
        key: m.key,
        outcome: "unsent",
        reason: "No publication attempt; run preview",
      });
      return { result, resolutions };
    }
    if (r.outcome === "verified") {
      const ids = await verifyPublishedReceipt(r, row, deps);
      result.meetings.push({
        key: m.key,
        outcome: "already_published",
        messageIds: ids,
      });
      return { result, resolutions };
    }
    if (r.ownerState === "settled") {
      result.meetings.push({
        key: m.key,
        outcome: "unsent",
        reason: "Known unsent; refresh preview",
      });
      return { result, resolutions };
    }
    const ready: Ready = { key: m.key, outcome: "ready", binding: m.binding };
    const pages = await inspectPages(r, deps);
    if (pages.some((p) => p.kind === "submitted" || p.kind === "uncertain")) {
      result.meetings.push({
        key: m.key,
        outcome: "uncertain",
        reason: "Positive message-ID evidence required; no automatic retry",
      });
      return { result, resolutions };
    }
    const stoppedEvidence = await deps.stopped(r.processId);
    if (!stoppedEvidence) {
      result.meetings.push({
        key: m.key,
        outcome: "blocked",
        reason: "Prior process has no positive stopped-run evidence",
      });
      return { result, resolutions };
    }
    const operation = pages.every((p) => p.kind === "verified")
      ? "finalize"
      : pages.some((p) => p.kind === "verified")
        ? "continue"
        : "release";
    resolutions.push({
      meeting: ready,
      receipt: r,
      pages,
      operation,
      stoppedEvidence,
    });
    result.meetings.push({
      key: m.key,
      outcome: operation === "release" ? "unsent" : "partial",
      reason: "Approval-ready " + operation + " plan available",
    });
  } catch {
    result.meetings.push({
      key: m.key,
      outcome: "uncertain",
      reason:
        "Provider/source evidence unavailable or changed; inspect private receipts",
    });
  }

  return { result, resolutions };
}

async function inspectPages(
  r: FirstPublicationReceipt,
  deps: FirstPublicationDependencies,
) {
  const pages: PublicationPage[] = [];
  for (const [i, page] of r.pages.entries()) {
    if (
      page.kind === "verified" ||
      (page.kind === "uncertain" && page.messageId)
    ) {
      const id = page.messageId;
      if (!id) throw Error("Uncertain message ID");
      const fingerprint = verifyFirstPublicationMessage(
        await deps.discord.getMessage(r.channelId, id),
        r.payloads[i],
        r.channelId,
        r.botId,
      );
      pages.push({
        kind: "verified",
        at: deps.now(),
        messageId: id,
        fingerprint,
      });
    } else pages.push(page);
  }

  return pages;
}
async function preflightResolution(
  m: FirstPublicationPlan["meetings"][number],
  plan: FirstPublicationPlan,
  state: Inspection,
  deps: FirstPublicationDependencies,
) {
  if (m.outcome !== "ready") throw Error("Invalid resolution selection");
  const replay = await settledResolution(m, plan, state, deps);
  if (replay) return replay;
  const current = state.resolutions.find(
      (r) => r.receipt.authority === m.binding.authority,
    ),
    approved = plan.resolution.find((r) => r.authority === m.binding.authority);
  if (
    !current ||
    !approved ||
    current.operation !== plan.operation ||
    digest(current.receipt) !== approved.receiptDigest ||
    current.stoppedEvidence !== approved.stoppedEvidence
  )
    throw Error("Resolution evidence changed; rerun reconcile");
  if (plan.operation === "continue") await assertLive(m, deps, current.receipt);
  return { current };
}

function appendPreflightFailure(
  plan: FirstPublicationPlan,
  result: PublicationResult,
  e: unknown,
) {
  for (const m of plan.meetings)
    if (
      m.outcome === "ready" &&
      !result.meetings.some((r) => digest(r.key) === digest(m.key))
    )
      result.meetings.push({
        key: m.key,
        outcome: "blocked",
        reason: e instanceof Error ? e.message : "Preflight unavailable",
      });
}

async function settledResolution(
  m: Ready,
  plan: FirstPublicationPlan,
  state: Inspection,
  deps: FirstPublicationDependencies,
) {
  const previous = await deps.repository.readAttempt(m.binding.authority);
  if (
    previous?.ownerState === "settled" &&
    previous.resolutionDigests?.includes(plan.digest)
  ) {
    const verified = state.result.meetings.find(
      (r) =>
        digest(r.key) === digest(m.key) && r.outcome === "already_published",
    );
    if (previous.outcome === "verified" && verified) {
      return { done: verified };
    }
    if (plan.operation === "release" && previous.outcome === "unsent") {
      return {
        done: {
          key: m.key,
          outcome: "unsent" as const,
          reason: "Release already verified",
        },
      };
    }
  }

  return null;
}
