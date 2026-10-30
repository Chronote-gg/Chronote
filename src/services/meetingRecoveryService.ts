import {
  noSpeechNoticeAcknowledged,
  terminalDeliveryAcknowledged,
} from "./meetingRecoveryAcknowledgment";
import { recordNotesAcknowledgement } from "../observability/meetingNotesLatency";
import { EMPTY_RECORDING_NOTICE } from "../utils/meetingProcessing";
import {
  summarizeCaptureCoverage,
  withMeetingCaptureNotice,
} from "../utils/meetingCaptureNotice";
import { buildMeetingNotesEmbeds } from "../utils/meetingNotes";
import { recoveryHistoryKey } from "../types/meetingRecovery";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { DeploymentControlRepository } from "../repositories/deploymentControlRepository";
import type { RecoveryClaim } from "../types/meetingRecovery";
import type { RecoveryDisposition } from "../types/recordingCheckpoint";
import {
  readRecoveryContent,
  recoverTranscript,
  recoveryNotesInput,
  InvalidRecoveryContent,
  TranscriptOverlapUnknown,
  type RecoveryReader,
} from "./meetingRecoveryContent";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "./meetingNotesService";
import { resolveCompletionPolicy } from "./meetingCompletionPolicyService";
import { createDiscordMessage } from "./discordMessageService";
import { uploadObjectToS3 } from "./storageService";
import type { TranscriptionContentInput } from "./transcriptionService";
import { autoExportRecoveredMeeting } from "./notionAutomationService";
import {
  registerNotionMutationTracker,
  UnresolvedNotionMutation,
} from "./notionOperationLifetime";

type RecoveryPatch = Parameters<
  DeploymentControlRepository["updateRecordingRecovery"]
>[1];
export class RecoveryMutationUnknown extends Error {}
export type RecoveryDependencies = {
  repository: Pick<
    DeploymentControlRepository,
    "updateRecordingRecovery" | "getMeetingHistory"
  >;
  reader: RecoveryReader;
  signal: AbortSignal;
  now(): number;
  nowMs(): number;
  effect: TranscriptionContentInput["effect"];
  notes: typeof ensureMeetingNotes;
  summaries: typeof ensureMeetingSummaries;
  transcript: typeof recoverTranscript;
  upload: typeof uploadObjectToS3;
  send: typeof createDiscordMessage;
  autoExport: typeof autoExportRecoveredMeeting;
};
export async function persistRecovery(
  claim: RecoveryClaim,
  patch: RecoveryPatch,
  deps: Pick<RecoveryDependencies, "repository" | "signal" | "now" | "effect">,
) {
  deps.signal.throwIfAborted();
  const expected = { ...claim.history, ...patch };
  try {
    const updated = await deps.effect(() =>
      deps.repository.updateRecordingRecovery(claim, patch, deps.now()),
    );
    if (!updated) throw new Error("Recovery stage was fenced");
    claim.history = updated;
  } catch (error) {
    const current = await deps.effect(() =>
      deps.repository.getMeetingHistory(
        recoveryHistoryKey(claim.history),
        deps.signal,
      ),
    );
    if (
      !current ||
      current.ownerInstanceId !== expected.ownerInstanceId ||
      current.executionVersion !== expected.executionVersion ||
      current.meetingId !== expected.meetingId ||
      !Object.entries(patch).every(
        ([key, value]) =>
          value === undefined ||
          isDeepStrictEqual(
            JSON.parse(
              JSON.stringify(current[key as keyof typeof current] ?? null),
            ),
            JSON.parse(JSON.stringify(value)),
          ),
      )
    )
      throw new RecoveryMutationUnknown(
        "Recovery stage acknowledgment is unknown",
        { cause: error },
      );
    claim.history = current;
  }
  deps.signal.throwIfAborted();
}
async function finish(
  claim: RecoveryClaim,
  outcome: Extract<RecoveryDisposition, { disposition: "done" }>["outcome"],
  deps: RecoveryDependencies,
  preserveStatus = false,
) {
  await persistRecovery(
    claim,
    {
      recovery: {
        attempt: claim.history.recovery!.attempt,
        executionVersion: claim.lease.executionVersion,
        stage: claim.history.recovery!.stage,
        retry: { maxAttempts: 4, nextAttemptAt: null },
        disposition: "done",
        outcome,
      },
      status: preserveStatus
        ? claim.history.status
        : claim.history.capture?.kind === "complete"
          ? "complete"
          : "interrupted",
    },
    deps,
  );
}
async function reconcile(
  claim: RecoveryClaim,
  reason: Extract<
    RecoveryDisposition,
    { disposition: "needs_reconciliation" }
  >["reason"],
  deps: RecoveryDependencies,
) {
  await persistRecovery(
    claim,
    {
      recovery: {
        ...claim.history.recovery!,
        disposition: "needs_reconciliation",
        reason,
        retry: { maxAttempts: 4, nextAttemptAt: null },
      },
    },
    deps,
  );
}
async function deliver(claim: RecoveryClaim, deps: RecoveryDependencies) {
  await persistRecovery(
    claim,
    {
      recovery: {
        ...claim.history.recovery!,
        stage: "delivery",
        disposition: "needs_reconciliation",
        reason: "delivery_uncertain",
      },
    },
    deps,
  );
  const row = claim.history;
  const channel = row.textChannelId ?? row.channelId;
  try {
    const summary = await deps.effect(() =>
      deps.send(
        channel,
        {
          embeds: [
            {
              title:
                row.capture?.kind === "complete"
                  ? "Recovered meeting"
                  : "Recovered partial meeting",
              description: withMeetingCaptureNotice(
                row.summarySentence ??
                  "Notes recovered from saved conversation.",
                row,
              ),
            },
          ],
          allowed_mentions: { parse: [] },
        },
        deps.signal,
      ),
    );
    if (!summary.id) throw new Error("Summary acknowledgment missing");
    await persistRecovery(claim, { summaryMessageId: summary.id }, deps);
    const ids: string[] = [];
    const embeds = buildMeetingNotesEmbeds({
      ...row,
      notesBody: row.notes!,
      meetingName:
        row.capture?.kind === "complete"
          ? "Recovered meeting notes"
          : "Recovered partial notes",
    });
    for (const embed of embeds) {
      const message = await deps.effect(() =>
        deps.send(
          channel,
          { embeds: [{ ...embed.toJSON() }], allowed_mentions: { parse: [] } },
          deps.signal,
        ),
      );
      const timing = recordNotesAcknowledgement(
        claim.history.notesDeliveryTiming,
        {
          acknowledgedAt: new Date(deps.nowMs()).toJSON() ?? "",
          complete: embed === embeds.at(-1),
          path: "recovery",
        },
      );
      if (!message.id) throw new Error("Notes acknowledgment missing");
      ids.push(message.id);
      await persistRecovery(
        claim,
        {
          notesMessageIds: [...ids],
          notesChannelId: channel,
          ...(timing ? { notesDeliveryTiming: timing } : {}),
        },
        deps,
      );
    }
    await persistRecovery(
      claim,
      {
        status:
          claim.history.capture?.kind === "complete"
            ? "complete"
            : "interrupted",
        delivery: {
          ...claim.history.delivery,
          summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
          notes: {
            outcome: "complete",
            intended: ids.length,
            sent: ids.length,
            errors: [],
          },
        },
      },
      deps,
    );
  } catch (error) {
    throw new RecoveryMutationUnknown(
      "Final delivery acknowledgment is unknown",
      { cause: error },
    );
  }
}
async function deliverNoSpeechNotice(
  claim: RecoveryClaim,
  deps: RecoveryDependencies,
) {
  await persistRecovery(
    claim,
    {
      recovery: {
        ...claim.history.recovery!,
        stage: "delivery",
        disposition: "needs_reconciliation",
        reason: "delivery_uncertain",
        retry: { maxAttempts: 4, nextAttemptAt: null },
      },
    },
    deps,
  );
  try {
    const row = claim.history;
    const message = await deps.effect(() =>
      deps.send(
        row.textChannelId ?? row.channelId,
        {
          content:
            row.capture?.kind === "complete"
              ? EMPTY_RECORDING_NOTICE
              : `Recording was interrupted. ${EMPTY_RECORDING_NOTICE}`,
          allowed_mentions: { parse: [] },
        },
        deps.signal,
      ),
    );
    if (!message.id) throw new Error("Notice acknowledgment missing");
    await persistRecovery(
      claim,
      {
        summaryMessageId: message.id,
        delivery: {
          ...claim.history.delivery,
          summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
        },
      },
      deps,
    );
    await finish(claim, "no_usable_speech", deps);
  } catch (error) {
    throw new RecoveryMutationUnknown(
      "Interruption notice acknowledgment is unknown",
      { cause: error },
    );
  }
}
async function recoveryTranscript(
  claim: RecoveryClaim,
  content: Awaited<ReturnType<typeof readRecoveryContent>>,
  deps: RecoveryDependencies,
) {
  const receipt = claim.history.recoveryTranscript;
  if (receipt) {
    if (
      receipt.checkpointRevision !== claim.history.checkpoint?.revision ||
      receipt.object.key !== claim.history.transcriptS3Key ||
      !receipt.object.key.startsWith(
        `${claim.history.checkpoint.artifactFolder}recovery/`,
      )
    )
      throw new InvalidRecoveryContent("Recovered transcript receipt mismatch");
    const saved = await deps.effect(() =>
      deps.reader.readVerifiedObject(receipt.object, deps.signal),
    );
    if (!saved)
      throw new InvalidRecoveryContent(
        "Recovered transcript verification failed",
      );
    const parsed = z
      .object({
        text: z.string(),
        meetingId: z.string(),
        guildId: z.string(),
        channelId: z.string(),
      })
      .parse(JSON.parse(Buffer.from(saved).toString("utf8")));
    if (
      parsed.meetingId !== claim.history.meetingId ||
      parsed.guildId !== claim.history.guildId ||
      parsed.channelId !== claim.history.channelId
    )
      throw new InvalidRecoveryContent(
        "Recovered transcript identity mismatch",
      );
    return parsed.text;
  }
  const { text, segments } = await deps.effect(() =>
    deps.transcript(content, deps.reader, deps.signal, deps.effect),
  );
  const key = `${claim.history.checkpoint!.artifactFolder}recovery/${claim.lease.executionVersion}/transcript.json`;
  const bytes = Buffer.from(
    JSON.stringify({
      generatedAt: new Date(deps.now() * 1000).toISOString(),
      guildId: claim.history.guildId,
      channelId: claim.history.channelId,
      meetingId: claim.history.meetingId,
      text,
      processing: content.processing,
      segments,
      timingBasis: "sample_cursor_with_observed_gaps",
      coverage: content.coverage,
    }),
  );
  const object = {
    key,
    byteLength: bytes.byteLength,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await deps.effect(() =>
    deps.upload(key, bytes, "application/json", {
      signal: deps.signal,
      immutable: true,
    }),
  );
  if (
    !(await deps.effect(() =>
      deps.reader.readVerifiedObject(object, deps.signal),
    ))
  )
    throw new Error("Recovered transcript upload was not verified");
  await persistRecovery(
    claim,
    {
      transcriptS3Key: key,
      recoveryTranscript: {
        checkpointRevision: claim.history.checkpoint!.revision,
        object,
      },
    },
    deps,
  );
  return text;
}
async function recoverGeneration(
  claim: RecoveryClaim,
  content: Awaited<ReturnType<typeof readRecoveryContent>>,
  transcript: string,
  deps: RecoveryDependencies,
) {
  const input = recoveryNotesInput(
    claim.history,
    content,
    transcript,
    deps.signal,
    claim.history.capture?.kind === "interrupted",
  );
  const notes = await deps.effect(() => deps.notes(input));
  if (!notes || input.processing?.notes !== "generated")
    throw new Error("Recovered notes were not generated");
  await persistRecovery(claim, { notes, processing: input.processing }, deps);
  await deps.effect(() => deps.summaries(input, notes));
  if (input.processing?.summary !== "generated")
    throw new Error("Recovered summary was not generated");
  await persistRecovery(
    claim,
    {
      summarySentence: input.summarySentence,
      summaryLabel: input.summaryLabel,
      processing: input.processing,
    },
    deps,
  );
  await deliver(claim, deps);
}
async function prepareRecoveryCapture(
  claim: RecoveryClaim,
  content: Awaited<ReturnType<typeof readRecoveryContent>>,
  deps: RecoveryDependencies,
) {
  const capture =
    claim.history.capture &&
    ["complete", "interrupted"].includes(claim.history.capture.kind)
      ? claim.history.capture
      : content.manifest.captureState.kind === "complete"
        ? content.manifest.captureState
        : {
            kind: "interrupted" as const,
            startedAt: content.manifest.capture.captureStartedAt,
            detectedAt: new Date(deps.now() * 1000).toISOString(),
            endedAt:
              content.manifest.captureState.kind === "interrupted"
                ? content.manifest.captureState.endedAt
                : null,
          };
  await persistRecovery(
    claim,
    {
      capture,
      captureCoverage: summarizeCaptureCoverage(content.coverage),
      status: capture.kind === "complete" ? "processing" : "interrupted",
    },
    deps,
  );
  const originalPolicy =
    claim.history.completionPolicy ?? content.context.completion;
  if (claim.history.completionPolicy?.decision === "cancel") {
    await reconcile(claim, "policy_unknown", deps);
    return false;
  }
  const policy = resolveCompletionPolicy(
    originalPolicy,
    capture.kind === "interrupted",
  );
  if (policy !== "proceed") {
    await reconcile(claim, "policy_unknown", deps);
    return false;
  }

  return true;
}
async function recoverFailure(
  claim: RecoveryClaim,
  error: unknown,
  deps: RecoveryDependencies,
) {
  deps.signal.throwIfAborted();
  if (error instanceof RecoveryMutationUnknown) throw error;
  if (error instanceof TranscriptOverlapUnknown) {
    await reconcile(claim, "transcript_overlap_unknown", deps);
    return;
  }
  if (
    error instanceof InvalidRecoveryContent ||
    error instanceof z.ZodError ||
    error instanceof SyntaxError
  ) {
    await reconcile(claim, "invalid_payload", deps);
    return;
  }
  const attempt = claim.history.recovery!.attempt;
  if (attempt >= 4) {
    await reconcile(claim, "retry_exhausted", deps);
    return;
  }
  await persistRecovery(
    claim,
    {
      recovery: {
        ...claim.history.recovery!,
        disposition: "failed",
        retry: {
          maxAttempts: 4,
          nextAttemptAt: new Date(
            (deps.now() + [60, 300, 900][attempt - 1]) * 1000,
          ).toISOString(),
        },
      },
    },
    deps,
  );
}
async function completeRecoveryExport(
  claim: RecoveryClaim,
  deps: RecoveryDependencies,
) {
  if (!terminalDeliveryAcknowledged(claim.history))
    throw new RecoveryMutationUnknown(
      "Recovered terminal content is not acknowledged",
    );
  if (!claim.history.recoveryExport) {
    await persistRecovery(
      claim,
      {
        recovery: {
          attempt: claim.history.recovery!.attempt,
          executionVersion: claim.lease.executionVersion,
          stage: "export",
          disposition: "pending",
          retry: { maxAttempts: 4, nextAttemptAt: null },
        },
        recoveryExport: {
          checkpointRevision: claim.history.checkpoint!.revision,
          intentExecutionVersion: claim.lease.executionVersion,
          state: "pending",
        },
      },
      deps,
    );
  }
  const receipt = claim.history.recoveryExport!;
  if (receipt.state === "submitted")
    throw new RecoveryMutationUnknown(
      "Submitted export requires reconciliation",
    );
  if (receipt.state === "pending") {
    let submissionStarted = false;
    const unregister = registerNotionMutationTracker(
      deps.signal,
      async (run) => {
        submissionStarted = true;
        if (claim.history.recoveryExport!.state === "pending")
          await persistRecovery(
            claim,
            {
              recoveryExport: { ...receipt, state: "submitted" },
              recovery: {
                ...claim.history.recovery!,
                stage: "export",
                disposition: "needs_reconciliation",
                reason: "export_uncertain",
                retry: { maxAttempts: 4, nextAttemptAt: null },
              },
            },
            deps,
          );
        deps.signal.throwIfAborted();
        return deps.effect(run);
      },
    );
    let state: Awaited<ReturnType<RecoveryDependencies["autoExport"]>>;
    try {
      state = await deps.effect(() =>
        deps.autoExport(claim.history, deps.signal),
      );
    } catch (error) {
      // The local pending receipt alone cannot disprove an unknown submission write.
      if (
        submissionStarted ||
        claim.history.recoveryExport?.state !== "pending" ||
        error instanceof RecoveryMutationUnknown ||
        error instanceof UnresolvedNotionMutation
      )
        throw error;
      await recoverFailure(claim, error, deps);
      return;
    } finally {
      unregister();
    }
    deps.signal.throwIfAborted();
    await persistRecovery(
      claim,
      { recoveryExport: { ...receipt, state } },
      deps,
    );
  }
  await finish(claim, "completed", deps, true);
}

export async function recoverMeeting(
  claim: RecoveryClaim,
  deps: RecoveryDependencies,
): Promise<void> {
  if (claim.history.recovery?.disposition === "done") return;
  if (claim.history.recovery?.stage === "export") {
    await completeRecoveryExport(claim, deps);
    return;
  }
  // Delivery reconciliation never resends Discord. A never-submitted export may follow.
  if (claim.history.recovery?.stage === "delivery") {
    if (noSpeechNoticeAcknowledged(claim.history))
      await finish(claim, "no_usable_speech", deps);
    else if (terminalDeliveryAcknowledged(claim.history))
      await completeRecoveryExport(claim, deps);
    return;
  }
  try {
    const content = await deps.effect(() =>
      readRecoveryContent(claim.history, deps.reader, deps.signal),
    );
    if (!(await prepareRecoveryCapture(claim, content, deps))) return;
    if (!content.manifest.capture.requested.transcribeMeeting) {
      await finish(claim, "disabled", deps);
      return;
    }
    await persistRecovery(
      claim,
      {
        recovery: {
          ...claim.history.recovery!,
          stage:
            claim.history.recovery!.stage === "verification"
              ? "transcription"
              : claim.history.recovery!.stage,
        },
      },
      deps,
    );
    const transcript = await recoveryTranscript(claim, content, deps);
    if (!transcript.trim()) {
      await persistRecovery(
        claim,
        {
          processing: {
            transcription: "empty",
            notes: "skipped",
            summary: "skipped",
          },
        },
        deps,
      );
      await deliverNoSpeechNotice(claim, deps);
      return;
    }
    await persistRecovery(
      claim,
      { recovery: { ...claim.history.recovery!, stage: "notes" } },
      deps,
    );
    if (!content.manifest.capture.requested.generateNotes) {
      await persistRecovery(
        claim,
        {
          processing: {
            transcription:
              claim.history.capture?.kind === "complete" ? "ready" : "partial",
            notes: "skipped",
            summary: "skipped",
          },
        },
        deps,
      );
      await finish(claim, "disabled", deps);
      return;
    }
    await recoverGeneration(claim, content, transcript, deps);
  } catch (error) {
    await recoverFailure(claim, error, deps);
    return;
  }
  await completeRecoveryExport(claim, deps);
}
