import { MEETING_UPDATE_CLAIM_LEASE_SECONDS } from "../repositories/meetingUpdateDeliveryRepository";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  applyDeliveryChange,
  pointersFor,
} from "../repositories/meetingUpdateDeliveryState";
import {
  readMeetingUpdateRevisions,
  type MeetingUpdateDeliveryTransition,
  type MeetingUpdateSubmission,
  type MeetingUpdateProgress,
  presentationPartSchema,
} from "../types/meetingUpdateDelivery";
import {
  MeetingDeliveryStopped,
  MEETING_UPDATE_REQUEST_TIMEOUT_MS,
  type DeliveryHistory,
  type DeliveryAttemptProgress,
  type MeetingDeliveryClaim,
  type MeetingDeliveryDependencies,
  type MeetingDeliveryRunInput,
  type MeetingDeliveryRunResult,
} from "./meetingUpdateDeliveryTypes";

export function createDeliveryContext(
  deps: MeetingDeliveryDependencies,
  input: MeetingDeliveryRunInput,
) {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let claim: MeetingDeliveryClaim | null = null;
  let attempt: DeliveryAttemptProgress["attempt"] | null = null;
  let summary: { id?: string; channel?: string } | null = null;
  let botId: string | null = null;
  function selectBotId(id: string) {
    botId = id;
  }
  let invokedAdmission = false;
  let renewalFailed = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> = Promise.resolve();
  let writes: Promise<unknown> = Promise.resolve();
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = writes.then(run, run);
    writes = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  function invokedWrite() {
    invokedAdmission = true;
  }
  const timeout = deps.requestTimeoutMs ?? MEETING_UPDATE_REQUEST_TIMEOUT_MS;
  const mainSignal = () =>
    AbortSignal.any([
      input.work.signal,
      ...(input.signal ? [input.signal] : []),
      AbortSignal.timeout(timeout),
    ]);
  async function effect<T>(
    run: (signal: AbortSignal) => Promise<T>,
    terminal = false,
  ): Promise<T> {
    if (terminal && claim) {
      const signal = AbortSignal.timeout(timeout);
      return input.work.trackTerminalEffect(() => run(signal), claim, signal);
    }
    const signal = mainSignal();
    return input.work.trackEffect(() => {
      signal.throwIfAborted();
      return run(signal);
    });
  }
  function acquireAttempt(
    row: DeliveryHistory,
    prepared: DeliveryAttemptProgress["attempt"],
    authority: Parameters<typeof deps.repository.claim>[0]["authority"],
  ) {
    return effect((signal) => {
      invokedWrite();
      return deps.repository.claim({
        key: input.key,
        expectedContentRevision:
          readMeetingUpdateRevisions(row).contentRevision,
        expectedDeliveryRevision: row.updateDelivery.revision,
        attempt: prepared,
        authority,
        signal,
      });
    });
  }
  async function read(terminal = false): Promise<DeliveryHistory> {
    const row = await effect(
      (signal) => deps.repository.getStrong(input.key, signal),
      terminal,
    );
    if (!row?.updateDelivery)
      throw new MeetingDeliveryStopped("Delivery no longer exists");
    return { ...row, updateDelivery: row.updateDelivery };
  }
  function confirmsChange(
    after: DeliveryHistory,
    expected: DeliveryHistory["updateDelivery"],
    change: MeetingUpdateDeliveryTransition,
  ) {
    if (isDeepStrictEqual(after.updateDelivery, expected)) return true;
    if (change.kind === "complete")
      return (
        isDeepStrictEqual(
          after.updateDelivery.lastSuccess,
          expected.lastSuccess,
        ) &&
        presentationPartSchema.options.every(
          (part) =>
            after.updateDelivery.parts[part].acknowledged >=
            expected.parts[part].acknowledged,
        )
      );
    return (
      change.kind === "progress" &&
      "attempt" in change.progress &&
      "attempt" in after.updateDelivery.progress &&
      isDeepStrictEqual(after.updateDelivery.progress, expected.progress)
    );
  }
  function own(row: DeliveryHistory): DeliveryAttemptProgress {
    const progress = row.updateDelivery.progress;
    if (
      !("attempt" in progress) ||
      !claim ||
      !attempt ||
      progress.attempt.attemptId !== claim.claimId ||
      progress.claim.ownerInstanceId !== claim.instanceId ||
      !isDeepStrictEqual(progress.attempt, attempt)
    )
      throw new MeetingDeliveryStopped("Claim changed");
    return progress;
  }
  function capture(
    row: DeliveryHistory,
    expectedAttempt: DeliveryAttemptProgress["attempt"],
    authority: Parameters<typeof deps.repository.claim>[0]["authority"],
  ) {
    const progress = row.updateDelivery.progress;
    const expectedOwner =
      authority.kind === "serving"
        ? authority.context.instanceId
        : authority.ownership.ownerInstanceId;
    if (
      !("attempt" in progress) ||
      !isDeepStrictEqual(progress.attempt, expectedAttempt) ||
      progress.claim.ownerInstanceId !== expectedOwner
    )
      throw new MeetingDeliveryStopped("Acquired claim changed before capture");
    attempt = progress.attempt;
    const summaryTarget = attempt.observations.find(
      (target) =>
        !attempt!.expectedPointers.notesMessageIds.includes(target.messageId),
    );
    summary = summaryTarget
      ? { id: summaryTarget.messageId, channel: summaryTarget.channelId }
      : {};
    claim = {
      claimId: attempt.attemptId,
      instanceId: progress.claim.ownerInstanceId,
      expiresAt: progress.claim.leaseExpiresAt,
    };
    input.work.recordClaim(claim);
    input.work.claimed();
  }
  async function admitClaimMutation(row: DeliveryHistory) {
    await input.work.authority();
    input.signal?.throwIfAborted();
    const progress = own(row);
    if (
      row.updateDelivery.policy.kind !== "active" ||
      progress.claim.leaseExpiresAt <= now() ||
      progress.kind === "uncertain"
    )
      throw new MeetingDeliveryStopped("Claim mutation no longer admitted");
  }
  async function applyChange(
    row: DeliveryHistory,
    change: MeetingUpdateDeliveryTransition,
    terminal = true,
  ): Promise<DeliveryHistory> {
    const current = await read(terminal);
    if (!terminal) await admitClaimMutation(current);
    if (claim) {
      const progress = own(current);
      if (change.kind === "progress" && "attempt" in change.progress) {
        const leaseExpiresAt = Math.max(
          progress.claim.leaseExpiresAt,
          change.progress.claim.leaseExpiresAt,
        );
        const next = {
          ...change.progress,
          claim: { ...progress.claim, leaseExpiresAt },
        };
        change = {
          ...change,
          progress:
            "nextCheckAt" in next
              ? {
                  ...next,
                  nextCheckAt: Math.max(next.nextCheckAt, leaseExpiresAt),
                }
              : next,
        };
      }
    } else if (current.updateDelivery.revision !== row.updateDelivery.revision)
      throw new MeetingDeliveryStopped("Unclaimed delivery changed");
    row = current;
    const expected = applyDeliveryChange(row.updateDelivery, change);
    let acknowledged = false;
    try {
      acknowledged =
        (await effect((signal) => {
          invokedWrite();
          return deps.repository.transition({
            key: input.key,
            expectedDeliveryRevision: row.updateDelivery.revision,
            attemptId: claim?.claimId ?? null,
            ownerInstanceId: claim?.instanceId ?? null,
            change,
            signal,
          });
        }, terminal)) === "applied";
    } catch {
      /* Only exact independent readback permits continuing. */
    }
    const after = await read(true);
    if (!confirmsChange(after, expected, change))
      throw new MeetingDeliveryStopped(
        "Transition acknowledgement is unproven",
      );
    if (claim && "attempt" in after.updateDelivery.progress) {
      claim = {
        ...claim,
        expiresAt: after.updateDelivery.progress.claim.leaseExpiresAt,
      };
      input.work.recordClaim(claim);
    }
    void acknowledged;
    return after;
  }
  function change(
    row: DeliveryHistory,
    change: MeetingUpdateDeliveryTransition,
    terminal = true,
  ) {
    return serialize(() => applyChange(row, change, terminal));
  }
  async function progress(row: DeliveryHistory, next: MeetingUpdateProgress) {
    return change(row, {
      kind: "progress",
      revision: randomUUID(),
      progress: next,
    });
  }
  async function submission(
    index: number,
    next: MeetingUpdateSubmission,
  ): Promise<DeliveryHistory> {
    const row = await read(next.kind !== "submitted");
    const before = own(row);
    return change(
      row,
      {
        kind: "progress",
        revision: randomUUID(),
        progress: {
          ...before,
          operations: before.operations.map((op, i) =>
            i === index ? { ...op, submission: next } : op,
          ),
        },
      },
      next.kind !== "submitted",
    );
  }
  function result(
    kind: MeetingDeliveryRunResult["kind"],
    row?: DeliveryHistory,
    reason?: string,
  ): MeetingDeliveryRunResult {
    const base = {
      ...(!invokedAdmission
        ? { noClaim: { kind: "never_admitted" as const } }
        : {}),
      capturedRevision:
        attempt?.contentRevision ??
        (row && "attempt" in row.updateDelivery.progress
          ? row.updateDelivery.progress.attempt.contentRevision
          : null),
      ...(row
        ? { durable: { deliveryRevision: row.updateDelivery.revision, claim } }
        : {}),
    };
    if (kind === "retryable")
      return {
        ...base,
        kind,
        retryAt:
          row && "nextCheckAt" in row.updateDelivery.progress
            ? row.updateDelivery.progress.nextCheckAt
            : now(),
      };
    if (kind === "blocked")
      return { ...base, kind, reason: reason ?? "unsupported_layout" };
    return { ...base, kind };
  }
  function expectedPointers(row: DeliveryHistory) {
    const progress = own(row);
    const registered = progress.attempt.operations.findIndex(
      (op) => op.kind === "register",
    );
    const register = progress.attempt.operations[registered];
    if (
      register?.kind !== "register" ||
      progress.operations[registered].submission.kind !== "verified"
    )
      return progress.attempt.expectedPointers;
    return registeredPointers(progress, register);
  }
  function assertPointers(row: DeliveryHistory) {
    const currentSummary = row.summaryMessageId
      ? {
          id: row.summaryMessageId,
          channel: row.textChannelId ?? row.notesChannelId ?? "",
        }
      : {};
    if (
      !isDeepStrictEqual(pointersFor(row), expectedPointers(row)) ||
      !isDeepStrictEqual(summary, currentSummary)
    )
      throw new MeetingDeliveryStopped("Captured pointers changed");
  }
  async function guard() {
    if (renewalFailed) throw new MeetingDeliveryStopped("Renewal is unproven");
    await input.work.authority();
    const row = await read();
    const progress = own(row);
    assertPointers(row);
    if (
      row.updateDelivery.policy.kind !== "active" ||
      progress.kind !== "running" ||
      progress.claim.leaseExpiresAt <= now() ||
      readMeetingUpdateRevisions(row).contentRevision !==
        progress.attempt.contentRevision
    )
      throw new MeetingDeliveryStopped(
        "Captured work was superseded or fenced",
      );
    return row;
  }
  function startRenewals() {
    function schedule() {
      if (stopped || input.work.signal.aborted || input.signal?.aborted) return;
      timer = setTimeout(() => {
        renewal = serialize(async () => {
          if (stopped || input.work.signal.aborted || input.signal?.aborted)
            return;
          await input.work.authority();
          const row = await read();
          if (!("attempt" in row.updateDelivery.progress)) return;
          const progress = own(row);
          if (
            row.updateDelivery.policy.kind !== "active" ||
            progress.claim.leaseExpiresAt <= now()
          )
            throw new MeetingDeliveryStopped("Renewal no longer admitted");
          if (progress.kind === "uncertain") return;
          const leaseExpiresAt = now() + MEETING_UPDATE_CLAIM_LEASE_SECONDS;
          await applyChange(
            row,
            {
              kind: "progress",
              revision: randomUUID(),
              progress: {
                ...progress,
                claim: { ...progress.claim, leaseExpiresAt },
                nextCheckAt: Math.max(progress.nextCheckAt, leaseExpiresAt),
              },
            },
            false,
          );
        })
          .catch(() => {
            renewalFailed = true;
          })
          .finally(schedule);
      }, deps.renewalIntervalMs ?? 20000);
    }
    schedule();
  }
  async function stopRenewals() {
    stopped = true;
    clearTimeout(timer);
    await renewal;
    await writes;
    return !renewalFailed;
  }
  return {
    deps,
    input,
    now,
    effect,
    read,
    own,
    capture,
    change,
    progress,
    submission,
    result,
    guard,
    serialize,
    invokedWrite,
    acquireAttempt,
    startRenewals,
    stopRenewals,
    selectBotId,
    get botId() {
      return botId;
    },
    assertPointers,
    get claim() {
      return claim;
    },
    get attempt() {
      return attempt;
    },
  };
}
export type DeliveryContext = ReturnType<typeof createDeliveryContext>;
export function registeredPointers(
  progress: DeliveryAttemptProgress,
  register: Extract<
    DeliveryAttemptProgress["attempt"]["operations"][number],
    { kind: "register" }
  >,
) {
  return {
    notesChannelId: register.notesChannelId,
    notesMessageIds: register.slots.map((slot) => {
      if (slot.kind === "existing") return slot.messageId;
      const index = progress.attempt.operations.findIndex(
        (op) => op.operationId === slot.operationId,
      );
      const result = progress.operations[index].submission;
      if (result.kind !== "verified" || result.receipt.kind !== "message")
        throw new MeetingDeliveryStopped("POST receipt is unverified");
      return result.receipt.messageId;
    }),
  };
}
