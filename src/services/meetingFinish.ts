import { promises as fs } from "node:fs";
import type {
  FinishClaim,
  FinishState,
  MeetingFinishRepository,
} from "../repositories/meetingFinishRepository";
import { getMeetingFinishRepository } from "../repositories/meetingFinishRepository";
import {
  buildAutoRecordCancelledEmbed,
  type SummaryUpgradeOffer,
} from "../embed";
import type { MeetingHistory } from "../types/db";
import type { CompletionPolicy } from "../types/meetingCompletionPolicy";
import type { DeliveryResult } from "../types/meetingDelivery";
import {
  finishedMeetingStatus,
  MEETING_END_REASONS,
  MEETING_STATUS,
  type MeetingStatus,
} from "../types/meetingLifecycle";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import {
  abandonedLifecycleDelivery,
  publicationSnapshot,
  settledLifecycleDelivery,
  unpublishedLifecycleDelivery,
} from "../types/meetingPublication";
import { MEETING_UPDATE_DELIVERY_QUEUE } from "../types/meetingUpdateDelivery";
import {
  MEETING_DELIVERY_FAILED_LOG,
  MEETING_FINISH_FAILED_LOG,
  meetingDeliveries,
  meetingFinishes,
  meetingFinishRetries,
} from "../metrics";
import { renderChatEntryLine } from "../utils/chatLog";
import { resolveHistoryActorId } from "../utils/meetingLifecycle";
import {
  PROCESSING_FAILED_NOTICE,
  TRANSCRIPTION_FAILED,
} from "../utils/meetingProcessing";
import { trimNotesForHistory } from "../utils/notesHistory";
import { captureEvent } from "./analyticsService";
import { config } from "./configService";
import {
  createDiscordMessageTransport,
  DiscordMessageHttpError,
} from "./discordMessageEditor";
import { LIFECYCLE } from "./lifecycleTiming";
import {
  classifyDeliveryError,
  DELIVERY_DONE,
  deliverMeeting,
  deliverNotice,
  renderMeetingDelivery,
  type DeliveryOutcome,
  type DeliveryTransport,
  type RestMessage,
} from "./meetingDelivery";
import {
  defaultFinishFollowOns,
  meetingArtifactFolder,
  runFollowOns,
  uploadRecording,
  type FinishFollowOns,
  type FollowOnAttempt,
} from "./meetingFinishFollowOns";
import type { FinishInput } from "./meetingFinishInput";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "./meetingNotesService";
import { uploadVerifiedObjectToS3 } from "./storageService";
import { claimSummaryUpgrade } from "./summaryUpgradeService";

const MS_PER_SECOND = 1000;
const TERMINAL_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.COMPLETE,
  MEETING_STATUS.INTERRUPTED,
  MEETING_STATUS.CANCELLED,
  MEETING_STATUS.FAILED,
];
const ACKNOWLEDGED_SUMMARY: DeliveryResult = {
  outcome: "complete",
  intended: 1,
  sent: 1,
  errors: [],
};

/** Delivery plus deleting the auto-record notices a cancellation removes. */
export type FinishTransport = DeliveryTransport &
  Pick<ReturnType<typeof createDiscordMessageTransport>, "deleteNotesMessage">;

export type MeetingFinishDeps = {
  repository: Pick<
    MeetingFinishRepository,
    "renew" | "save" | "releaseDone" | "releaseForRetry"
  >;
  transport: FinishTransport;
  upload: typeof uploadVerifiedObjectToS3;
  notes: typeof ensureMeetingNotes;
  summaries: typeof ensureMeetingSummaries;
  claimUpgrade(
    history: MeetingHistory,
  ): Promise<SummaryUpgradeOffer | undefined>;
  followOns: FinishFollowOns;
  nowMs(): number;
  /** Runs `run` once after `delayMs` and returns a function that cancels it. */
  schedule(run: () => Promise<void>, delayMs: number): () => void;
};

export type FinishOptions = {
  deliver?: boolean;
  /** Stops the attempt like a lost claim: no retry is scheduled and the claim stays as it is. */
  signal?: AbortSignal;
};
type Load = (signal: AbortSignal) => Promise<FinishInput>;
type RetrySchedule = Parameters<MeetingFinishRepository["releaseForRetry"]>[1];

class FinishClaimLost extends Error {
  constructor() {
    super("Meeting finish claim was lost");
    this.name = "FinishClaimLost";
  }
}

/** Epoch seconds of the next process attempt, or undefined when this failure is final. */
export function nextFinishRetry(
  attempts: number,
  now: number,
): number | undefined {
  const delay = LIFECYCLE.finishBackoffSeconds.at(attempts);
  return delay === undefined ? undefined : now + delay;
}

/**
 * Epoch seconds of the next delivery attempt, or undefined once delivery has
 * been failing for the give-up period. The last attempt lands exactly on it.
 */
export function nextDeliveryRetry(
  state: Pick<FinishState, "attempts" | "deliverSince">,
  now: number,
): number | undefined {
  const since = state.deliverSince ?? now;
  const giveUpAt = since + LIFECYCLE.deliveryGiveUpSeconds;
  if (now >= giveUpAt) return undefined;
  const delay =
    LIFECYCLE.deliveryBackoffSeconds.at(state.attempts) ??
    LIFECYCLE.deliveryHourlySeconds;
  return Math.min(now + delay, giveUpAt);
}

const isTerminal = (status: MeetingStatus | undefined) =>
  status !== undefined && TERMINAL_STATUSES.includes(status);

/** A recovery value the old runtime left, which reads as a publication still under way. */
const leftoverRecovery = (row: MeetingHistory) =>
  row.recovery !== undefined && row.recovery.disposition !== "done";

/** Delivery is finished when it completed or was recorded as failed. */
const deliverySettled = (row: MeetingHistory) =>
  row.recovery?.disposition === "done" ||
  row.delivery?.notes?.outcome === "failed";

const captureEndIso = (row: MeetingHistory) =>
  new Date(
    Date.parse(row.timestamp) + row.duration * MS_PER_SECOND,
  ).toISOString();

function terminalStatus(row: MeetingHistory, input: FinishInput) {
  if (input.cancel) return MEETING_STATUS.CANCELLED;
  return finishedMeetingStatus(row.capture);
}

function notesVersionFields(row: MeetingHistory, input: FinishInput) {
  const notes = input.notesInput.notesText;
  if (!notes) return {};
  const notesVersion = row.notesVersion ?? 1;
  const notesLastEditedBy =
    row.notesLastEditedBy ??
    row.meetingCreatorId ??
    input.notesInput.creator.id;
  const notesLastEditedAt = row.notesLastEditedAt ?? captureEndIso(row);
  return {
    notesVersion,
    notesLastEditedBy,
    notesLastEditedAt,
    notesHistory: [
      {
        version: notesVersion,
        notes: trimNotesForHistory(notes),
        editedBy: notesLastEditedBy,
        editedAt: notesLastEditedAt,
      },
    ],
  };
}

/**
 * What today's cancellation stores: the decision, its reason and how it ended.
 * The stored policy schema requires the full snapshot, so the decision is
 * written onto the row's snapshot or the one the loader carries.
 */
function cancellationFields(
  row: MeetingHistory,
  input: FinishInput,
): Partial<MeetingHistory> {
  const decision: CompletionPolicy["decision"] = input.cancel
    ? "cancel"
    : "proceed";
  const snapshot = row.completionPolicy ?? input.completionPolicy;
  return {
    ...(snapshot ? { completionPolicy: { ...snapshot, decision } } : {}),
    ...(input.cancel
      ? {
          cancellationReason: input.cancel.reason,
          endReason:
            row.endReason === MEETING_END_REASONS.DISMISSED
              ? MEETING_END_REASONS.DISMISSED
              : MEETING_END_REASONS.AUTO_CANCELLED,
        }
      : {}),
  };
}

/** A decision close already wrote is final: a retry or another loader never reverses it. */
function withRowDecision(row: MeetingHistory, input: FinishInput): FinishInput {
  const decided = row.completionPolicy?.decision;
  if (decided === "cancel" && !input.cancel)
    return { ...input, cancel: { reason: row.cancellationReason } };
  if (decided === "proceed" && input.cancel) {
    return { ...input, cancel: undefined };
  }
  return input;
}

function processingOutcome(input: FinishInput): MeetingProcessingOutcome {
  const notes = input.notesInput;
  const processing = { ...input.processing, ...notes.processing };
  // Recovery records notes as skipped when the recording asked for none.
  return !notes.generateNotes && notes.transcribeMeeting && !input.cancel
    ? { ...processing, notes: "skipped", summary: "skipped" }
    : processing;
}

function cancelledMessage(
  history: MeetingHistory,
  input: FinishInput | undefined,
): RestMessage {
  const embed = buildAutoRecordCancelledEmbed({
    startTriggeredByUserId: history.startTriggeredByUserId,
    autoRecordRule: history.autoRecordRule,
    cancellationReason: history.cancellationReason,
    endReason: history.endReason,
    voiceChannelName: input?.notesInput.voiceChannel.name || undefined,
  });
  return {
    embeds: [{ ...embed.toJSON() }],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

function failedDeliveryError(error: unknown): DeliveryResult["errors"][number] {
  return error instanceof DiscordMessageHttpError
    ? { status: error.status, code: error.discordCode }
    : {};
}

function releasedHoldFields(
  released: NonNullable<ReturnType<typeof settledLifecycleDelivery>>,
): Partial<MeetingHistory> {
  return {
    updateDelivery: released.delivery,
    ...(released.dueAt === undefined
      ? {}
      : {
          updateDeliveryQueue: MEETING_UPDATE_DELIVERY_QUEUE,
          updateDeliveryDueAt: released.dueAt,
        }),
  };
}

/** The completing or abandoning delivery save releases a lifecycle hold on a correction. */
function releasedHold(row: MeetingHistory, patch: Partial<MeetingHistory>) {
  const before = {
    ...publicationSnapshot(row),
    lifecycleVersion: row.lifecycleVersion,
  };
  const released =
    settledLifecycleDelivery(before, patch) ??
    abandonedLifecycleDelivery(before, patch);
  return released ? releasedHoldFields(released) : {};
}

/**
 * The notes chunk count, or undefined when rendering fails, so a give-up or a
 * delivered event never depends on the renderer that may be what failed.
 */
function renderedNotesCount(row: MeetingHistory): number | undefined {
  try {
    return renderMeetingDelivery(row).notes.length;
  } catch {
    return undefined;
  }
}

/**
 * The stages as stored when steps 1 to 3 gave up, so a portal retry can rerun
 * them: generation outcomes as recorded, else a failure before notes (loading,
 * transcription or storing the transcript) as transcription failed. A failed
 * row stores no notes, so notes generated in the failed attempt count as
 * failed. A cancellation records nothing, so no retry is offered for it.
 */
function failedProcessing(
  input: FinishInput | undefined,
): MeetingProcessingOutcome | undefined {
  if (input?.cancel) return undefined;
  const outcome = input && processingOutcome(input);
  if (!outcome || !Object.values(outcome).includes("failed"))
    return TRANSCRIPTION_FAILED;
  return outcome.notes === "generated"
    ? { ...outcome, notes: "failed" }
    : outcome;
}

function logContext(row: MeetingHistory) {
  return { guildId: row.guildId, meetingId: row.meetingId };
}

/** One finish attempt: the claim, the latest acknowledged row and the attempt's signal. */
type Attempt = {
  claim: FinishClaim;
  row: MeetingHistory;
  controller: AbortController;
  signal: AbortSignal;
  options: FinishOptions;
  /** Delivery had already settled when this attempt claimed the row. */
  settledAtClaim: boolean;
  source: FinishInput["source"];
  load: Load;
  /** The normal loader's directory: removed only once the claim is released as done. */
  localDirectories: string[];
  /** Recovery mixes are never reused by a later attempt, so every exit removes them. */
  transientDirectories: string[];
};

export function createMeetingFinisher(deps: MeetingFinishDeps) {
  const nowSeconds = () => Math.floor(deps.nowMs() / MS_PER_SECOND);

  async function load(a: Attempt) {
    a.signal.throwIfAborted();
    const input = await a.load(a.signal);
    if (input.localDirectory)
      (input.source === "normal"
        ? a.localDirectories
        : a.transientDirectories
      ).push(input.localDirectory);
    return input;
  }

  function lost(a: Attempt): never {
    a.controller.abort(new FinishClaimLost());
    throw new FinishClaimLost();
  }

  /** Every write goes through the claim; a refused write means another worker owns the meeting. */
  async function save(
    a: Attempt,
    patch: Partial<MeetingHistory>,
    expectedStatus?: MeetingStatus,
  ) {
    a.signal.throwIfAborted();
    const saved = await deps.repository.save(
      a.claim,
      patch,
      nowSeconds(),
      expectedStatus,
    );
    if (!saved) lost(a);
    a.row = saved;
    return saved;
  }

  /**
   * Delivery saves. The save that completes or gives up delivery also releases
   * a correction held while delivery ran, computed from the latest acknowledged
   * row and refused if a correction landed since, so the next attempt recomputes
   * it rather than overwriting the newer request.
   */
  async function saveDelivery(a: Attempt, patch: Partial<MeetingHistory>) {
    a.signal.throwIfAborted();
    const settling =
      patch.recovery !== undefined ||
      patch.delivery?.notes?.outcome === "failed";
    const saved = await deps.repository.save(
      a.claim,
      { ...patch, ...(settling ? releasedHold(a.row, patch) : {}) },
      nowSeconds(),
      undefined,
      settling ? { updateDelivery: a.row.updateDelivery } : undefined,
    );
    if (saved) a.row = saved;
    return saved;
  }

  async function uploadChat(a: Attempt, input: FinishInput) {
    if (!input.chatEntries || a.row.chatS3Key) return undefined;
    const folder = meetingArtifactFolder(a.row);
    const text = await deps.upload(
      `${folder}chat.txt`,
      input.chatEntries
        .map((entry) =>
          renderChatEntryLine(entry, { includeAttachmentUrls: true }),
        )
        .join("\n"),
      "text/plain; charset=utf-8",
      { signal: a.signal },
    );
    // Entries are stored in their own shape, as today's chat.json is.
    const json = await deps.upload(
      `${folder}chat.json`,
      JSON.stringify(input.chatEntries, null, 2),
      "application/json",
      { signal: a.signal },
    );
    if (!text || !json)
      throw new Error("Meeting chat log upload was not stored");
    return json.key;
  }

  async function uploadTranscript(a: Attempt, input: FinishInput) {
    if (!input.transcriptUpload || a.row.transcriptS3Key) return undefined;
    const { key, body } = input.transcriptUpload;
    const stored = await deps.upload(key, body, "application/json", {
      signal: a.signal,
    });
    if (!stored) throw new Error("Meeting transcript upload was not stored");
    return stored.key;
  }

  /**
   * Step 1. The chat log goes first and is recorded at once: only the normal
   * loader has the entries, so a transcript failure must not lose them.
   */
  async function uploadInputs(a: Attempt, input: FinishInput) {
    const chatS3Key = await uploadChat(a, input);
    if (chatS3Key) await save(a, { chatS3Key });
    const transcriptS3Key = await uploadTranscript(a, input);
    if (transcriptS3Key) await save(a, { transcriptS3Key });
  }

  async function generate(a: Attempt, input: FinishInput) {
    if (input.cancel) return;
    const notes = await deps.notes(input.notesInput);
    a.signal.throwIfAborted();
    await deps.summaries(input.notesInput, notes);
    a.signal.throwIfAborted();
    // Generation reports failure as an outcome rather than throwing; a failed
    // outcome is retried as today's paths do, never saved as terminal.
    if (Object.values(processingOutcome(input)).includes("failed"))
      throw new Error("Meeting transcription, notes or summary failed");
  }

  async function saveTerminal(a: Attempt, input: FinishInput) {
    const row = a.row;
    const notes = input.notesInput;
    const status = terminalStatus(row, input);
    const now = nowSeconds();
    await save(
      a,
      {
        status,
        notes: input.cancel ? undefined : notes.notesText,
        meetingName: notes.meetingName,
        summarySentence: notes.summarySentence,
        summaryLabel: notes.summaryLabel,
        processing: processingOutcome(input),
        participants: input.participants,
        tags: notes.tags,
        ...(input.cancel ? {} : notesVersionFields(row, input)),
        ...cancellationFields(row, input),
        ...(input.captureCoverage && !row.captureCoverage
          ? { captureCoverage: input.captureCoverage }
          : {}),
        updatedAt: new Date(now * MS_PER_SECOND).toISOString(),
        finish: {
          ...(row.finish?.startedAt === undefined
            ? {}
            : { startedAt: row.finish.startedAt }),
          owner: a.claim.owner,
          expiresAt: now + LIFECYCLE.finishClaimSeconds,
          attempts: 0,
          phase: "deliver",
        },
      },
      MEETING_STATUS.PROCESSING,
    );
    meetingFinishes.inc({ outcome: status });
  }

  async function saveFailed(a: Attempt, processing?: MeetingProcessingOutcome) {
    await save(
      a,
      {
        status: MEETING_STATUS.FAILED,
        processing,
        updatedAt: new Date(deps.nowMs()).toISOString(),
      },
      MEETING_STATUS.PROCESSING,
    );
    meetingFinishes.inc({ outcome: MEETING_STATUS.FAILED });
  }

  async function releaseDone(a: Attempt) {
    await deps.repository.releaseDone(a.claim);
    for (const directory of a.localDirectories)
      await fs.rm(directory, { recursive: true, force: true });
  }

  /** Steps 1 to 3 failed: retry with backoff, or on the fourth failure end failed with one notice. */
  async function processFailed(
    a: Attempt,
    error: unknown,
    input: FinishInput | undefined,
  ) {
    const attempts = a.row.finish?.attempts ?? 0;
    const next = nextFinishRetry(attempts, nowSeconds());
    console.warn("Meeting finish attempt failed", {
      ...logContext(a.row),
      attempts: attempts + 1,
      error,
    });
    if (next !== undefined) {
      await deps.repository.releaseForRetry(a.claim, {
        attempts: attempts + 1,
        nextAttemptAt: next,
        phase: "process",
      });
      meetingFinishRetries.inc({ phase: "process" });
      return;
    }
    await saveFailed(a, failedProcessing(input));
    console.error(MEETING_FINISH_FAILED_LOG, { ...logContext(a.row), error });
    if (a.options.deliver !== false && a.row.textChannelId)
      await deliverNotice(
        a.row,
        PROCESSING_FAILED_NOTICE,
        a.signal,
        deps.transport,
      ).catch((noticeError: unknown) =>
        console.warn("Processing failed notice was not delivered", {
          ...logContext(a.row),
          error: noticeError,
        }),
      );
    await releaseDone(a);
  }

  /**
   * Steps 1 to 3. Returns the input once a terminal status is saved, or
   * undefined when the attempt already ended in a retry or a final failure.
   */
  async function processMeeting(a: Attempt): Promise<FinishInput | undefined> {
    let input: FinishInput | undefined;
    try {
      input = withRowDecision(a.row, await load(a));
      a.source = input.source;
      // Only a recovery with no saved audio at all ends here, silently. A
      // cancellation is honoured first; a live capture with no speech is empty.
      if (!input.cancel && !input.hasSavedAudio) {
        await saveFailed(a);
        return input;
      }
      await uploadInputs(a, input);
      await generate(a, input);
      await saveTerminal(a, input);
      return input;
    } catch (error) {
      if (a.signal.aborted) throw error;
      await processFailed(a, error, input);
      return undefined;
    }
  }

  async function deleteNotices(
    a: Attempt,
    channelId: string,
    ids: string[] | undefined,
  ) {
    for (const messageId of ids ?? [])
      await deps.transport
        .deleteNotesMessage({ channelId, messageId, signal: a.signal })
        .catch((error: unknown) =>
          console.warn("Failed to delete auto-record notice message", {
            ...logContext(a.row),
            error,
          }),
        );
  }

  /** The cancelled embed replaces the start message, then the same done marker a full delivery writes. */
  async function deliverCancelled(
    a: Attempt,
    input: FinishInput | undefined,
  ): Promise<DeliveryOutcome> {
    const row = a.row;
    const channelId = row.textChannelId;
    if (!channelId) return { kind: "not_applicable" };
    const payload = cancelledMessage(row, input);
    try {
      if (
        !row.startMessageId ||
        !(await deps.transport.updateMessage({
          channelId,
          messageId: row.startMessageId,
          payload,
          signal: a.signal,
        }))
      )
        await deps.transport.createMessage({
          channelId,
          payload,
          signal: a.signal,
        });
    } catch (error) {
      if (a.signal.aborted) throw error;
      return { kind: classifyDeliveryError(error), error };
    }
    await deleteNotices(a, channelId, input?.noticeMessageIds);
    await save(a, {
      delivery: { ...row.delivery, summary: ACKNOWLEDGED_SUMMARY },
      recovery: DELIVERY_DONE,
    });
    return { kind: "delivered" };
  }

  async function claimUpgrade(a: Attempt) {
    try {
      return await deps.claimUpgrade(a.row);
    } catch (error) {
      console.warn("Summary upgrade lookup failed", {
        ...logContext(a.row),
        error,
      });
      return undefined;
    }
  }

  function captureUpgradeDelivered(row: MeetingHistory, notesChunks: number) {
    const surfaces = notesChunks
      ? ["discord_summary", "discord_notes"]
      : ["discord_summary"];
    for (const surface of surfaces)
      captureEvent("upgrade_offer_delivered", {
        userId: resolveHistoryActorId(row),
        guildId: row.guildId,
        properties: { surface, event_version: 1 },
      });
  }

  /**
   * Step 4. Undefined when there is nothing to deliver. A meeting with no
   * usable speech goes through the same summary card as notes, carrying the
   * no-speech notice, so it shares the marker, readback and retry rules.
   */
  async function deliver(
    a: Attempt,
    input: FinishInput | undefined,
  ): Promise<DeliveryOutcome | undefined> {
    const row = a.row;
    if (
      row.status === MEETING_STATUS.FAILED ||
      deliverySettled(row) ||
      a.options.deliver === false
    )
      return undefined;
    if (row.status === MEETING_STATUS.CANCELLED)
      return deliverCancelled(a, input);
    // The receipt spends the week's reminder, so an aborted attempt must not claim it.
    a.signal.throwIfAborted();
    const upgrade = await claimUpgrade(a);
    const outcome = await deliverMeeting({
      history: row,
      save: (patch) => saveDelivery(a, patch),
      transport: deps.transport,
      signal: a.signal,
      path: a.source === "normal" ? "live" : "recovery",
      extras: { upgrade },
    });
    a.signal.throwIfAborted();
    if (outcome.kind === "delivered" && upgrade)
      captureUpgradeDelivered(row, renderedNotesCount(row) ?? 0);
    return outcome;
  }

  /** Any unexpected throw while delivering counts as a temporary failure, so it backs off and gives up. */
  async function deliverCounted(a: Attempt, input: FinishInput | undefined) {
    try {
      return await deliver(a, input);
    } catch (error) {
      if (a.signal.aborted) throw error;
      return { kind: "temporary" as const, error };
    }
  }

  async function recordDeliveryFailed(a: Attempt, error: unknown) {
    const row = a.row;
    const sent = row.notesMessageIds?.length ?? 0;
    const saved = await saveDelivery(a, {
      delivery: {
        ...row.delivery,
        notes: {
          outcome: "failed",
          intended:
            row.status === MEETING_STATUS.CANCELLED
              ? 0
              : (renderedNotesCount(row) ?? sent),
          sent,
          errors: [failedDeliveryError(error)],
        },
      },
    });
    if (!saved) lost(a);
  }

  /** Returns the retry schedule when delivery is to be retried later. */
  async function settleDelivery(
    a: Attempt,
    outcome: DeliveryOutcome | undefined,
  ): Promise<RetrySchedule | undefined> {
    if (!outcome) return undefined;
    if (outcome.kind === "delivered" || outcome.kind === "not_applicable") {
      meetingDeliveries.inc({ outcome: outcome.kind });
      return undefined;
    }
    if (outcome.kind === "temporary") {
      const finish =
        a.row.finish?.phase === "deliver" ? a.row.finish : undefined;
      const attempts = finish?.attempts ?? 0;
      const deliverSince = finish?.deliverSince ?? nowSeconds();
      const next = nextDeliveryRetry({ attempts, deliverSince }, nowSeconds());
      if (next !== undefined) {
        meetingDeliveries.inc({ outcome: "temporary" });
        console.warn("Meeting delivery will be retried", {
          ...logContext(a.row),
          error: outcome.error,
        });
        return {
          attempts: attempts + 1,
          nextAttemptAt: next,
          phase: "deliver",
          deliverSince,
        };
      }
    }
    await recordDeliveryFailed(a, outcome.error);
    meetingDeliveries.inc({ outcome: "failed" });
    if (outcome.kind === "temporary")
      console.error(MEETING_DELIVERY_FAILED_LOG, {
        ...logContext(a.row),
        error: outcome.error,
      });
    return undefined;
  }

  function followOnAttempt(
    a: Attempt,
    input: FinishInput | undefined,
  ): FollowOnAttempt {
    return {
      row: () => a.row,
      signal: a.signal,
      settledAtClaim: a.settledAtClaim,
      deliver: a.options.deliver !== false,
      input,
      loadForRecording: () => load(a),
      save: (patch) => save(a, patch),
      upload: deps.upload,
      followOns: deps.followOns,
    };
  }

  async function run(a: Attempt) {
    let input: FinishInput | undefined;
    if (!isTerminal(a.row.status)) {
      input = await processMeeting(a);
      if (!input) return;
    }
    const retry = await settleDelivery(a, await deliverCounted(a, input));
    if (retry) {
      // The local recording may not survive to the next attempt.
      await uploadRecording(followOnAttempt(a, input), input);
      await deps.repository.releaseForRetry(a.claim, retry);
      meetingFinishRetries.inc({ phase: "deliver" });
      return;
    }
    await runFollowOns(followOnAttempt(a, input));
    if (a.options.deliver === false) await releaseUndeliveredHold(a);
    await releaseDone(a);
  }

  /**
   * With delivery not run, a correction held for it would wait forever, so it
   * is kept as unpublished. The row is refreshed first so a correction made
   * during this attempt is seen; a correction racing the release stays held.
   * A correction landing after the refresh saw no hold, and before
   * `releaseDone`, is stamped held, stays held and is not logged.
   *
   * A recovery value the old runtime left reads as a publication still under
   * way, so the same write removes it: the meeting is then settled and
   * unpublished. The delivery-done marker is never written, since nothing was
   * published for a later correction to edit.
   */
  async function releaseUndeliveredHold(a: Attempt) {
    if (
      !isTerminal(a.row.status) ||
      (deliverySettled(a.row) && !leftoverRecovery(a.row))
    )
      return;
    const fresh = await save(a, {});
    const leftover = leftoverRecovery(fresh);
    // A given-up delivery already released its hold in the save that recorded it.
    const released = deliverySettled(fresh)
      ? undefined
      : unpublishedLifecycleDelivery(
          {
            ...publicationSnapshot({ ...fresh, recovery: undefined }),
            lifecycleVersion: fresh.lifecycleVersion,
          },
          {},
        );
    if (!released && !leftover) return;
    const saved = await deps.repository.save(
      a.claim,
      released ? releasedHoldFields(released) : {},
      nowSeconds(),
      undefined,
      { updateDelivery: fresh.updateDelivery },
      leftover ? ["recovery"] : [],
    );
    if (saved) a.row = saved;
    else
      console.warn(
        "Undelivered meeting correction stays held",
        logContext(a.row),
      );
  }

  /**
   * Finishes one claimed meeting: saves its result once, delivers it, then runs
   * the follow-ons. Each step is skipped when the row already records its
   * output, so a retry after a crash resumes where the last attempt stopped.
   * An attempt that starts on a terminal row calls `load` only to recover the
   * recording, so any attempt other than the closing worker's first must be
   * given the recovery loader.
   */
  async function finishMeeting(
    claim: FinishClaim,
    loadInput: Load,
    options: FinishOptions = {},
  ): Promise<void> {
    const controller = new AbortController();
    const a: Attempt = {
      claim,
      row: claim.history,
      controller,
      signal: controller.signal,
      options,
      settledAtClaim: deliverySettled(claim.history),
      source: "recovery",
      load: loadInput,
      localDirectories: [],
      transientDirectories: [],
    };
    const stop = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) stop();
    else options.signal?.addEventListener("abort", stop, { once: true });
    const startedMs = deps.nowMs();
    let ended = false;
    let cancelRenewal: () => void;
    const renew = async () => {
      if (deps.nowMs() - startedMs >= LIFECYCLE.finishAttemptMaxMs) {
        controller.abort(new Error("Meeting finish attempt exceeded its cap"));
        return;
      }
      try {
        if (!(await deps.repository.renew(claim, nowSeconds()))) {
          controller.abort(new FinishClaimLost());
          return;
        }
      } catch (error) {
        console.warn("Meeting finish claim renewal failed", {
          ...logContext(claim.history),
          error,
        });
      }
      // A renewal still in flight when the attempt ends must not keep the claim alive.
      if (!ended && !controller.signal.aborted)
        cancelRenewal = deps.schedule(renew, LIFECYCLE.finishClaimRenewMs);
    };
    cancelRenewal = deps.schedule(renew, LIFECYCLE.finishClaimRenewMs);
    try {
      await run(a);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      console.warn("Meeting finish attempt stopped", {
        ...logContext(claim.history),
        reason: controller.signal.reason,
      });
    } finally {
      ended = true;
      options.signal?.removeEventListener("abort", stop);
      cancelRenewal();
      for (const directory of a.transientDirectories)
        await fs
          .rm(directory, { recursive: true, force: true })
          .catch((error: unknown) =>
            console.warn("Recovery mix directory was not removed", {
              ...logContext(claim.history),
              error,
            }),
          );
    }
  }

  return { finishMeeting };
}

export type MeetingFinisher = ReturnType<typeof createMeetingFinisher>;

function claimHistoryUpgrade(history: MeetingHistory) {
  const startTime = new Date(history.timestamp);
  return claimSummaryUpgrade({
    guildId: history.guildId,
    meetingId: history.meetingId,
    transcribeMeeting: history.transcribeMeeting,
    generateNotes: history.generateNotes,
    notesText: history.notes,
    processing: history.processing,
    startTime,
    endTime: new Date(startTime.getTime() + history.duration * MS_PER_SECOND),
  });
}

function defaultDeps(): MeetingFinishDeps {
  const transport = createDiscordMessageTransport({
    token: config.discord.botToken,
  });
  return {
    repository: getMeetingFinishRepository(),
    transport,
    upload: uploadVerifiedObjectToS3,
    notes: ensureMeetingNotes,
    summaries: ensureMeetingSummaries,
    claimUpgrade: claimHistoryUpgrade,
    followOns: defaultFinishFollowOns(transport),
    nowMs: Date.now,
    schedule(run, delayMs) {
      const timer = setTimeout(() => void run(), delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    },
  };
}

let processFinisher: MeetingFinisher | undefined;
export function finishMeeting(
  claim: FinishClaim,
  load: Load,
  options?: FinishOptions,
): Promise<void> {
  processFinisher ??= createMeetingFinisher(defaultDeps());
  return processFinisher.finishMeeting(claim, load, options);
}
