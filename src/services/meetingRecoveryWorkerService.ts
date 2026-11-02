import {
  consumedFixtureMatches,
  type ConsumedFixtureGrant,
} from "./deploymentFixtureAdmission";
import { recoveryHistoryKey } from "../types/meetingRecovery";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDeploymentControlRepository } from "../db";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import { prepareRecoveryClaim } from "../repositories/meetingRecoveryRepository";
import type { ControlRecord, HistoryKey } from "../types/deploymentControl";
import type { RecoveryClaim } from "../types/meetingRecovery";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
  type RuntimeWorkClaim,
  releaseAcknowledgedRuntimeWork,
} from "./runtimeWorkAdmissionService";
import { createRecordingCheckpointService } from "./recordingCheckpointService";
import {
  recoverMeeting,
  type RecoveryDependencies,
} from "./meetingRecoveryService";
import { recoverTranscript } from "./meetingRecoveryContent";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "./meetingNotesService";
import { uploadObjectToS3 } from "./storageService";
import { createDiscordMessage } from "./discordMessageService";
import { autoExportRecoveredMeeting } from "./notionAutomationService";
import {
  prepareRecoveredMeeting,
  reconcileRecoveredMeeting,
} from "./ownedMeetingInterruption";

type WorkerDependencies = {
  repository: DeploymentControlRepository;
  begin: typeof beginRuntimeWorkClaim;
  recover: typeof recoverMeeting;
  content: Omit<
    RecoveryDependencies,
    "repository" | "signal" | "now" | "effect"
  >;
  now(): number;
  prepareLocal?(
    claim: RecoveryClaim,
    signal: AbortSignal,
    effect: RuntimeWorkClaim["trackEffect"],
  ): Promise<void>;
  reconcileLocal?(claim: RecoveryClaim): Promise<void>;
};
export function createMeetingRecoveryWorker(deps: WorkerDependencies) {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const handlers = new Set<Promise<boolean>>();
  const ownedRecoveries = new Map<
    string,
    { claim: RecoveryClaim; work: RuntimeWorkClaim }
  >();
  let unresolvedCursor:
    { id: string; work: RuntimeWorkClaim; expected: ControlRecord } | undefined;
  let transientCursor: HistoryKey | undefined;
  const sameControl = (actual: unknown, expected: ControlRecord) =>
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(actual ?? null)),
      JSON.parse(JSON.stringify(expected)),
    );

  function register(claim: RecoveryClaim, work: RuntimeWorkClaim) {
    work.recordClaim({
      claimId: claim.lease.recoveryAttemptId,
      instanceId: claim.lease.ownerInstanceId,
      attempt: claim.history.recovery!.attempt,
      expiresAt: claim.lease.leaseExpiresAt,
    });
  }
  async function claimKey(
    key: HistoryKey,
    work: RuntimeWorkClaim,
    submitted: () => void,
    fixtureGrant?: ConsumedFixtureGrant,
  ) {
    const authority = await work.authority();
    if (authority.kind !== "serving")
      throw new Error("Recovery requires serving admission");
    const history = await work.trackEffect(() =>
      deps.repository.getMeetingHistory(key, work.signal),
    );
    if (!history || history.status === "cancelled") return;
    const lease = await work.trackEffect(() =>
      deps.repository.getRecoveryLease(history.guildId),
    );
    const input = {
      history,
      lease,
      context: { ...authority.context, now: deps.now() },
      attemptId: randomUUID(),
      fixtureGrant,
    };
    const expected = prepareRecoveryClaim(input);
    if (!expected) return;
    try {
      return await work.trackEffect(() => {
        register(expected, work);
        submitted();
        return deps.repository.claimRecordingRecovery(input);
      });
    } catch (error) {
      const [current, owned] = await Promise.all([
        work.trackEffect(() =>
          deps.repository.getMeetingHistory(key, work.signal),
        ),
        work.trackEffect(() =>
          deps.repository.getRecoveryLease(history.guildId),
        ),
      ]);
      if (
        !isDeepStrictEqual(current, expected.history) ||
        !isDeepStrictEqual(owned, expected.lease)
      )
        throw error;
      return expected;
    }
  }
  async function release(claim: RecoveryClaim, work: RuntimeWorkClaim) {
    try {
      if (
        await work.trackEffect(() =>
          deps.repository.releaseRecordingRecovery(claim, deps.now()),
        )
      )
        return;
    } catch {
      /* Readback proves only this exact terminal history and remote absence. */
    }
    const [history, lease] = await Promise.all([
      work.trackEffect(() =>
        deps.repository.getMeetingHistory(
          recoveryHistoryKey(claim.history),
          work.signal,
        ),
      ),
      work.trackEffect(() =>
        deps.repository.getRecoveryLease(claim.history.guildId),
      ),
    ]);
    if (lease || !isDeepStrictEqual(history, claim.history))
      throw new Error("Recovery release is unresolved");
  }
  function ownsRecovery(id: string) {
    const owned = ownedRecoveries.get(id);
    if (!owned) return false;
    const registered = getRuntimeWorkAdmissionCheckpoints().find(
      (entry) => entry.id === id,
    );
    return (
      registered?.domain === "recovery" &&
      registered.signal === owned.work.signal &&
      isDeepStrictEqual(registered.claim, {
        claimId: owned.claim.lease.recoveryAttemptId,
        instanceId: owned.claim.lease.ownerInstanceId,
        attempt: owned.claim.history.recovery!.attempt,
        expiresAt: owned.claim.lease.leaseExpiresAt,
      })
    );
  }
  function process(key: HistoryKey, fixtureGrant?: ConsumedFixtureGrant) {
    key = recoveryHistoryKey(key);
    if (stopped) return Promise.resolve(false);
    const id = `recovery:${key.guildId}:${key.channelId_timestamp}`;
    // An existing exact claim is visited, never re-admitted, released or replayed.
    if (ownsRecovery(id)) return Promise.resolve(true);
    let work: RuntimeWorkClaim;
    try {
      work = deps.begin("recovery", id);
    } catch {
      return Promise.resolve(false);
    }
    const handler = work.trackPromise(async () => {
      let renewal: ReturnType<typeof setInterval> | undefined;
      let renewing: Promise<void> | undefined;
      let submitted = false;
      try {
        if (stopped) return false;
        const claim = await claimKey(
          key,
          work,
          () => {
            submitted = true;
          },
          fixtureGrant,
        );
        if (!claim) return true;
        register(claim, work);
        work.claimed();
        ownedRecoveries.set(id, { claim, work });
        renewal = setInterval(() => {
          if (renewing || stopped || work.signal.aborted) return;
          renewing = work
            .trackEffect(async () => {
              const lease = await deps.repository.renewRecordingRecovery(
                claim,
                deps.now(),
              );
              if (!lease) throw new Error("Recovery lease lost");
              claim.lease = lease;
              register(claim, work);
            })
            .catch(() => work.fence())
            .finally(() => {
              renewing = undefined;
            });
        }, 10000);
        renewal.unref();
        await deps.recover(claim, {
          ...deps.content,
          repository: deps.repository,
          signal: work.signal,
          now: deps.now,
          effect: (run) => work.trackEffect(run),
        });
        await deps.prepareLocal?.(claim, work.signal, (run) =>
          work.trackEffect(run),
        );
        clearInterval(renewal);
        await renewing;
        work.signal.throwIfAborted();
        if (claim.history.recovery?.disposition === "claimed")
          throw new Error("Recovery disposition remains unresolved");
        await release(claim, work);
        work.acknowledgeTerminal();
        ownedRecoveries.delete(id);
        // The original local owner stays held on failed proof; recovery's own terminal receipt remains valid.
        await deps.reconcileLocal?.(claim).catch(() => {});
        return true;
      } catch {
        const cancelled = stopped || work.signal.aborted;
        work.fence();
        return !cancelled && ownsRecovery(id);
      } finally {
        clearInterval(renewal);
        await renewing;
        if (!submitted) work.acknowledgeReadOnlyRecoveryPoll();
        await work.settle();
      }
    });
    handlers.add(handler);
    void handler.finally(() => handlers.delete(handler));
    return handler;
  }
  async function saveCursor(
    work: RuntimeWorkClaim,
    id: string,
    control: ControlRecord,
    context: Parameters<DeploymentControlRepository["saveRecoveryCursor"]>[0],
    next: HistoryKey | undefined,
  ) {
    const expected = { ...control, recoveryScanCursor: next };
    let submitted = false;
    try {
      const saved = await work.trackEffect(() => {
        submitted = true;
        return deps.repository.saveRecoveryCursor(
          context,
          control.recoveryScanCursor,
          next,
        );
      });
      return saved ? "saved" : "rejected";
    } catch {
      if (!submitted) return "rejected";
      try {
        const current = await work.trackEffect(() =>
          deps.repository.getRecord("ENV", "CONTROL"),
        );
        if (sameControl(current, expected)) return "saved";
      } catch {
        /* The original cursor mutation remains owned when readback is unavailable. */
      }
      unresolvedCursor = { id, work, expected };
      transientCursor = next;
      return "unknown";
    }
  }
  async function visitPage(keys: HistoryKey[], deadline: number) {
    for (const key of keys) {
      if (stopped || deps.now() >= deadline || !(await process(key)))
        return false;
    }
    return !stopped;
  }
  async function visitHeldFixtures(
    work: RuntimeWorkClaim,
    control: ControlRecord,
    deadline: number,
  ) {
    const hold = control.maintenance;
    if (!hold) return;
    const introduction = await work.trackEffect(() =>
      deps.repository.getRecord("ENV", "INTRODUCTION"),
    );
    if (!isHeldIntroduction(introduction, hold)) return;
    for (const id of introduction.fixtureGrantIds ?? []) {
      if (stopped || deps.now() >= deadline) return;
      const grant = await work.trackEffect(() =>
        deps.repository.getRecord(`FIXTURE#${id}`, "AUTHORITY"),
      );
      if (
        grant?.recordType === "fixture_grant" &&
        grant.state === "consumed" &&
        consumedFixtureMatches(hold, grant, grant)
      )
        await process(grant.historyKey, grant);
    }
  }
  async function scanPage(
    work: RuntimeWorkClaim,
    id: string,
    deadline: number,
  ) {
    const authority = await work.authority();
    if (authority.kind !== "serving" || stopped) return "end";
    const control = await work.trackEffect(() =>
      deps.repository.getRecord("ENV", "CONTROL"),
    );
    if (control?.recordType !== "control" || stopped) return "end";
    if (control.maintenance) {
      await visitHeldFixtures(work, control, deadline);
      return "end";
    }
    if (unresolvedCursor && sameControl(control, unresolvedCursor.expected)) {
      unresolvedCursor.work.acknowledgeReadOnlyRecoveryPoll();
      releaseAcknowledgedRuntimeWork(unresolvedCursor.id);
      unresolvedCursor = undefined;
      transientCursor = undefined;
    }
    const page = await work.trackEffect(() =>
      deps.repository.discoverRecordingRecoveries(
        unresolvedCursor ? transientCursor : control.recoveryScanCursor,
      ),
    );
    if (!(await visitPage(page.keys, deadline))) return "end";
    const latest = await work.authority();
    if (latest.kind !== "serving") return "end";
    if (unresolvedCursor) transientCursor = page.cursor;
    else {
      const saved = await saveCursor(
        work,
        id,
        control,
        { ...latest.context, now: deps.now() },
        page.cursor,
      );
      if (saved !== "saved") {
        work.fence();
        return saved === "unknown" ? "unknown" : "end";
      }
    }
    return page.cursor ? "more" : "end";
  }
  async function runPoll(work: RuntimeWorkClaim, id: string) {
    let cursorKnown = true;
    try {
      // Scheduling bounds, never a timeout for an already-owned effect.
      const deadline = deps.now() + 10;
      for (let count = 0; count < 20 && deps.now() < deadline; count++) {
        const result = await scanPage(work, id, deadline);
        cursorKnown = result !== "unknown";
        if (result !== "more") return;
      }
    } catch {
      work.fence();
    } finally {
      if (cursorKnown) work.acknowledgeReadOnlyRecoveryPoll();
      await work.settle();
    }
  }
  function poll(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    let work: RuntimeWorkClaim;
    const id = `recovery:poll:${randomUUID()}`;
    try {
      work = deps.begin("recovery", id);
    } catch {
      return Promise.resolve();
    }
    const actual = work.trackPromise(() => runPoll(work, id));
    pending = actual;
    void actual.finally(() => {
      if (pending === actual) pending = undefined;
    });
    return actual;
  }
  return {
    poll,
    process,
    start() {
      if (stopped || timer) return;
      void poll();
      timer = setInterval(
        () => {
          void poll();
        },
        5 * 60 * 1000,
      );
      timer.unref();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      return Promise.all([pending, ...handlers]).then(() => undefined);
    },
  };
}
let worker: ReturnType<typeof createMeetingRecoveryWorker> | undefined;
let sealed = false;
export function startMeetingRecoveryWorker() {
  if (sealed || worker) return;
  worker = createMeetingRecoveryWorker({
    repository: getDeploymentControlRepository(),
    begin: beginRuntimeWorkClaim,
    recover: recoverMeeting,
    prepareLocal: prepareRecoveredMeeting,
    reconcileLocal: reconcileRecoveredMeeting,
    now: () => Math.floor(Date.now() / 1000),
    content: {
      nowMs: Date.now,
      reader: createRecordingCheckpointService(),
      notes: ensureMeetingNotes,
      summaries: ensureMeetingSummaries,
      transcript: recoverTranscript,
      upload: uploadObjectToS3,
      send: createDiscordMessage,
      autoExport: autoExportRecoveredMeeting,
    },
  });
  worker.start();
}
export function stopMeetingRecoveryWorker(): Promise<void> {
  sealed = true;
  return worker?.stop() ?? Promise.resolve();
}

function isHeldIntroduction(
  record:
    import("../types/deploymentControl").DeploymentControlRecord | undefined,
  hold: import("../types/productionIntroduction").MaintenanceHold,
): record is import("../types/productionIntroduction").IntroductionHold {
  return (
    record?.recordType === "production_introduction" &&
    record.admission.state === "held" &&
    record.holdId === hold.holdId &&
    record.introductionId === hold.introductionId &&
    record.revision === hold.revision
  );
}
