import type { RepairPublicationOwner } from "../types/meetingPublication";
import { randomUUID } from "node:crypto";
import {
  DiscordMessageHttpError,
  discordBotIdentitySchema,
  discordChannelSchema,
  discordEditorMessageSchema,
} from "./discordMessageEditor";
import { previewRecoveryDiscordPublication } from "./recoveryDiscordPublicationPlan";
import {
  bindRecoveryPublication,
  publicationDigest,
  publicationMessageFingerprint,
  publicationHistorySchema,
  recoveryPublicationManifestSchema,
  recoveryDiscordPreviewSchema,
  publicationReceiptSchema,
  publicationClaimSchema,
  stablePublicationJson,
  type PublicationDependencies,
  type PublicationReceipt,
  type PublicationClaim,
  type RecoveryDiscordPreview,
} from "./recoveryDiscordPublicationTypes";

type ReadyPreview = Extract<RecoveryDiscordPreview, { kind: "ready" }>;
type MessageReceipt = PublicationReceipt["messages"][number];
type SavedReceipt = { value: PublicationReceipt; etag: string };
type SavedClaim = { value: PublicationClaim; etag: string };
export type PublicationReconcileOptions = { confirmRunStopped?: string };
const same = (left: unknown, right: unknown) =>
  stablePublicationJson(left) === stablePublicationJson(right);
const unresolved = (receipt: PublicationReceipt) =>
  receipt.messages
    .filter((m) => m.state === "submitted" || m.state === "uncertain")
    .map((m) => m.messageId);
const receiptKey = (preview: ReadyPreview) =>
  `${preview.binding.recoveryPrefix}discord-publication/${preview.previewDigest}/receipt.json`;

async function validatePreview(
  input: RecoveryDiscordPreview,
  deps: PublicationDependencies,
  regenerate = true,
): Promise<ReadyPreview> {
  const preview = recoveryDiscordPreviewSchema.parse(input);
  if (
    preview.kind !== "ready" ||
    !preview.targets.length ||
    !preview.botId ||
    publicationDigest(input) !== preview.previewDigest ||
    publicationDigest(preview) !== preview.previewDigest
  )
    throw new Error("Invalid or blocked publication preview");
  if (!regenerate) return preview;
  // Re-render from approved stored fields using the reviewed before-images, never trust an edited payload hash.
  const regenerated = await previewRecoveryDiscordPublication(preview.scope, {
    ...deps,
    now: () => preview.createdAt,
    discord: {
      ...deps.discord,
      getMessage: async (target) =>
        preview.targets.find(
          (t) =>
            t.messageId === target.messageId &&
            t.channelId === target.channelId,
        )?.before ?? null,
    },
  });
  if (regenerated.kind !== "ready" || !same(regenerated, preview))
    throw new Error(
      "Preview does not match the approved stored version and renderer",
    );
  return preview;
}

async function historyMatches(
  preview: ReadyPreview,
  deps: PublicationDependencies,
): Promise<boolean | null> {
  let history: unknown;
  let manifest: unknown;
  try {
    history = await deps.readHistory(preview.scope);
    manifest = await deps.readManifest(preview.scope);
  } catch {
    return null;
  }
  try {
    return same(
      bindRecoveryPublication(
        preview.scope,
        publicationHistorySchema.parse(history),
        recoveryPublicationManifestSchema.parse(manifest),
      ),
      preview.binding,
    );
  } catch {
    return false;
  }
}

async function checkHistory(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
) {
  const matches = await historyMatches(preview, deps);
  if (matches === true) return true;
  if (matches === false) receipt.status = "superseded";
  else {
    receipt.status = unresolved(receipt).length
      ? "uncertain"
      : receipt.messages.some((message) => message.state === "verified")
        ? "partial"
        : "failed";
    for (const message of receipt.messages)
      message.reason ??=
        "Stored version could not be read; synchronization is unverified";
  }
  return false;
}

async function observe(
  preview: ReadyPreview,
  index: number,
  deps: PublicationDependencies,
): Promise<string | null> {
  const target = preview.targets[index];
  try {
    const bot = discordBotIdentitySchema.parse(
      await deps.discord.getBotIdentity(),
    );
    const channel = discordChannelSchema.parse(
      await deps.discord.getChannel(target.channelId),
    );
    if (
      bot.id !== preview.botId ||
      channel.id !== target.channelId ||
      channel.guild_id !== preview.scope.guildId
    )
      return null;
    const message = discordEditorMessageSchema.parse(
      await deps.discord.getMessage(target),
    );
    if (
      message.id !== target.messageId ||
      message.channel_id !== target.channelId ||
      message.author.id !== bot.id ||
      !message.author.bot ||
      message.webhook_id ||
      (message.flags & 32768) !== 0
    )
      return null;
    return publicationMessageFingerprint(message);
  } catch {
    return null;
  }
}

function newReceipt(
  preview: ReadyPreview,
  deps: Pick<PublicationDependencies, "now">,
  runId: string = randomUUID(),
): PublicationReceipt {
  const now = deps.now();
  return {
    schemaVersion: 1,
    runId,
    previewDigest: preview.previewDigest,
    meetingId: preview.binding.meetingId,
    notesVersion: preview.binding.notesVersion,
    storedFieldsDigest: preview.binding.storedFieldsDigest,
    status: "running",
    startedAt: now,
    updatedAt: now,
    messages: preview.targets.map((target) => ({
      channelId: target.channelId,
      messageId: target.messageId,
      runId,
      state: "pending",
      updatedAt: now,
      beforeFingerprint: target.beforeFingerprint,
      desiredFingerprint: target.afterFingerprint,
      observedFingerprint: null,
      reason: null,
    })),
  };
}

function validateReceipt(
  preview: ReadyPreview,
  raw: PublicationReceipt,
): PublicationReceipt {
  const receipt = publicationReceiptSchema.parse(raw);
  const expected = newReceipt(
    preview,
    { now: () => receipt.startedAt },
    receipt.runId,
  );
  const identity = (value: PublicationReceipt) => ({
    previewDigest: value.previewDigest,
    meetingId: value.meetingId,
    notesVersion: value.notesVersion,
    storedFieldsDigest: value.storedFieldsDigest,
    messages: value.messages.map(
      ({
        channelId,
        messageId,
        runId,
        beforeFingerprint,
        desiredFingerprint,
      }) => ({
        channelId,
        messageId,
        runId,
        beforeFingerprint,
        desiredFingerprint,
      }),
    ),
  });
  if (!same(identity(receipt), identity(expected)))
    throw new Error("Receipt does not match preview");
  return receipt;
}

async function saveReceipt(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  etag: string | null,
  deps: PublicationDependencies,
): Promise<string> {
  const key = receiptKey(preview);
  receipt.updatedAt = deps.now();
  try {
    return await deps.storage.saveReceipt({
      key,
      receipt,
      condition: etag === null ? { kind: "absent" } : { kind: "match", etag },
    });
  } catch {
    const saved = await deps.storage.readReceipt(key);
    if (!saved?.etag || !same(saved.value, receipt))
      throw new Error(
        "Receipt write ownership or acknowledgment is unproven; reconcile before continuing",
      );
    return saved.etag;
  }
}

async function saveClaim(
  preview: ReadyPreview,
  claim: PublicationClaim,
  etag: string | null,
  deps: PublicationDependencies,
): Promise<string> {
  try {
    return await deps.storage.writeClaim({
      key: preview.binding.claimKey,
      claim,
      condition: etag === null ? { kind: "absent" } : { kind: "match", etag },
    });
  } catch {
    const saved = await deps.storage.readClaim(preview.binding.claimKey);
    if (!saved?.etag || !same(saved.value, claim))
      throw new Error(
        "Claim ownership is unproven; no Discord edit is permitted",
      );
    return saved.etag;
  }
}

async function acquire(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
): Promise<SavedClaim> {
  const previous = await deps.storage.readClaim(preview.binding.claimKey);
  if (previous) {
    const claim = publicationClaimSchema.parse(previous.value);
    if (
      claim.meetingId !== receipt.meetingId ||
      claim.notesVersion !== receipt.notesVersion ||
      claim.state !== "terminal" ||
      claim.unresolvedMessageIds.length
    )
      throw new Error(
        "Publication claim is occupied; reconcile and confirm the exact prior run has stopped",
      );
    const saved = await deps.storage.readReceipt(claim.receiptKey);
    if (
      !saved ||
      saved.value.runId !== claim.runId ||
      saved.value.previewDigest !== claim.previewDigest ||
      saved.value.meetingId !== receipt.meetingId ||
      saved.value.notesVersion !== receipt.notesVersion ||
      saved.value.status === "running" ||
      unresolved(saved.value).length
    )
      throw new Error("Prior claim has no proven terminal receipt");
  }
  const claim: PublicationClaim = {
    schemaVersion: 1,
    runId: receipt.runId,
    previewDigest: preview.previewDigest,
    meetingId: receipt.meetingId,
    notesVersion: receipt.notesVersion,
    state: "running",
    receiptKey: receiptKey(preview),
    unresolvedMessageIds: [],
  };
  return {
    value: claim,
    etag: await saveClaim(preview, claim, previous?.etag ?? null, deps),
  };
}

async function assertOwner(
  preview: ReadyPreview,
  claim: SavedClaim,
  deps: PublicationDependencies,
  owner: RepairPublicationOwner,
) {
  await deps.publication.assertOwner(owner);
  const saved = await deps.storage.readClaim(preview.binding.claimKey);
  if (
    !saved ||
    saved.etag !== claim.etag ||
    !same(saved.value, claim.value) ||
    saved.value.state !== "running"
  )
    throw new Error(
      "Publication claim changed; no further Discord edits are permitted",
    );
}

function updateMessage(
  message: MessageReceipt,
  state: MessageReceipt["state"],
  observed: string | null,
  reason: string | null,
  deps: PublicationDependencies,
) {
  Object.assign(message, {
    state,
    observedFingerprint: observed,
    reason,
    updatedAt: deps.now(),
  });
}

async function finish(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
) {
  if (receipt.status === "superseded") return;
  if (!(await checkHistory(preview, receipt, deps))) return;
  if (unresolved(receipt).length) receipt.status = "uncertain";
  else if (receipt.messages.every((m) => m.state === "verified"))
    receipt.status = "verified";
  else
    receipt.status = receipt.messages.some((m) => m.state === "verified")
      ? "partial"
      : "failed";
}

async function verifyReadOnly(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
) {
  for (let index = 0; index < receipt.messages.length; index++) {
    const observed = await observe(preview, index, deps);
    updateMessage(
      receipt.messages[index],
      observed === preview.targets[index].afterFingerprint
        ? "verified"
        : "failed",
      observed,
      observed === preview.targets[index].afterFingerprint
        ? null
        : "Previously verified message no longer matches",
      deps,
    );
  }
  await finish(preview, receipt, deps);
  return receipt;
}

async function preflight(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
) {
  if (!(await checkHistory(preview, receipt, deps))) return false;
  let valid = true;
  for (let index = 0; index < preview.targets.length; index++) {
    const target = preview.targets[index];
    const observed = await observe(preview, index, deps);
    if (observed === target.afterFingerprint)
      updateMessage(receipt.messages[index], "verified", observed, null, deps);
    else if (observed !== target.beforeFingerprint) {
      updateMessage(
        receipt.messages[index],
        "failed",
        observed,
        "Message changed or could not be read during preflight",
        deps,
      );
      valid = false;
    }
  }
  return valid;
}

async function patchTarget(
  preview: ReadyPreview,
  index: number,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
): Promise<{ proceed: boolean; settled: boolean }> {
  const target = preview.targets[index];
  const message = receipt.messages[index];
  let ambiguous = false;
  try {
    if (
      (await deps.discord.editEmbeds({
        channelId: target.channelId,
        messageId: target.messageId,
        embeds: target.afterEmbeds,
      })) === "missing"
    ) {
      updateMessage(
        message,
        "failed",
        null,
        "Discord rejected the edit: message missing",
        deps,
      );
      return { proceed: false, settled: true };
    }
  } catch (error) {
    if (
      error instanceof DiscordMessageHttpError &&
      [400, 401, 403, 404, 405, 413, 429].includes(error.status)
    ) {
      updateMessage(
        message,
        "failed",
        null,
        `Discord rejected the edit (${error.status})`,
        deps,
      );
      return { proceed: false, settled: true };
    }
    ambiguous = true;
  }
  const observed = await observe(preview, index, deps);
  const matched = observed === target.afterFingerprint;
  updateMessage(
    message,
    matched ? "verified" : "uncertain",
    observed,
    matched
      ? null
      : "Edit outcome is uncertain; never resubmit this request automatically",
    deps,
  );
  return { proceed: matched && !ambiguous, settled: !ambiguous };
}

async function editRemaining(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  claim: SavedClaim,
  initialEtag: string,
  deps: PublicationDependencies,
  owner: RepairPublicationOwner,
) {
  let etag = initialEtag;
  let settled = true;
  for (let index = 0; index < preview.targets.length; index++) {
    if (!(await checkHistory(preview, receipt, deps))) break;
    const target = preview.targets[index];
    const message = receipt.messages[index];
    const observed = await observe(preview, index, deps);
    if (observed === target.afterFingerprint) {
      updateMessage(message, "verified", observed, null, deps);
      continue;
    }
    if (message.state !== "pending" || observed !== target.beforeFingerprint) {
      updateMessage(
        message,
        "failed",
        observed,
        "Message changed immediately before edit",
        deps,
      );
      break;
    }
    await assertOwner(preview, claim, deps, owner);
    updateMessage(message, "submitted", observed, null, deps);
    etag = await saveReceipt(preview, receipt, etag, deps);
    await assertOwner(preview, claim, deps, owner);
    const result = await patchTarget(preview, index, receipt, deps);
    settled = settled && result.settled;
    etag = await saveReceipt(preview, receipt, etag, deps);
    if (!result.proceed) break;
  }
  return { etag, settled };
}

export async function applyRecoveryDiscordPublication(
  input: RecoveryDiscordPreview,
  deps: PublicationDependencies,
): Promise<PublicationReceipt> {
  const preview = await validatePreview(input, deps, false);
  const saved = await deps.storage.readReceipt(receiptKey(preview));
  if (saved) {
    const receipt = validateReceipt(preview, saved.value);
    if (receipt.status === "verified") return verifyRerun(preview, deps);
    throw new Error(
      "This preview already has a run; reconcile it and create a fresh preview for any retry",
    );
  }
  await validatePreview(preview, deps);
  const receipt = newReceipt(preview, deps);
  if (!(await preflight(preview, receipt, deps))) {
    await finish(preview, receipt, deps);
    return receipt;
  }
  await deps.storage.savePreview(preview);
  const claim = await acquire(preview, receipt, deps);
  const owner = await deps.publication.acquire({
    binding: preview.binding,
    previewDigest: preview.previewDigest,
    runId: receipt.runId,
    receiptKey: receiptKey(preview),
    reconcile: false,
  });
  let etag = await saveReceipt(preview, receipt, null, deps);
  const remaining = await editRemaining(
    preview,
    receipt,
    claim,
    etag,
    deps,
    owner,
  );
  etag = remaining.etag;
  await finish(preview, receipt, deps);
  await saveReceipt(preview, receipt, etag, deps);
  await saveClaim(
    preview,
    {
      ...claim.value,
      state: unresolved(receipt).length ? "running" : "terminal",
      unresolvedMessageIds: unresolved(receipt),
    },
    claim.etag,
    deps,
  );
  if (remaining.settled && unresolved(receipt).length === 0)
    await deps.publication.settle({
      owner,
      evidence: { kind: "known_settled" },
      adoptVerified: receipt.status === "verified",
    });
  return receipt;
}

async function loadReconciliation(
  preview: ReadyPreview,
  deps: PublicationDependencies,
): Promise<{
  receipt: PublicationReceipt;
  saved: SavedReceipt | null;
  claim: SavedClaim;
  owner: RepairPublicationOwner;
}> {
  const claim = await deps.storage.readClaim(preview.binding.claimKey);
  if (
    !claim ||
    claim.value.previewDigest !== preview.previewDigest ||
    claim.value.receiptKey !== receiptKey(preview) ||
    claim.value.meetingId !== preview.binding.meetingId ||
    claim.value.notesVersion !== preview.binding.notesVersion
  )
    throw new Error("No matching publication claim to reconcile");
  publicationClaimSchema.parse(claim.value);
  const saved = await deps.storage.readReceipt(receiptKey(preview));
  const receipt = saved
    ? validateReceipt(preview, saved.value)
    : newReceipt(preview, deps, claim.value.runId);
  if (receipt.runId !== claim.value.runId)
    throw new Error("Claim and receipt owners differ");
  const owner = await deps.publication.acquire({
    binding: preview.binding,
    previewDigest: preview.previewDigest,
    runId: receipt.runId,
    receiptKey: receiptKey(preview),
    reconcile: true,
  });
  return { receipt, saved, claim, owner };
}

async function verifyRerun(
  preview: ReadyPreview,
  deps: PublicationDependencies,
) {
  const { receipt, saved, claim, owner } = await loadReconciliation(
    preview,
    deps,
  );
  if (
    !saved ||
    receipt.status !== "verified" ||
    claim.value.unresolvedMessageIds.length
  )
    throw new Error(
      "Verified receipt and resolved claim evidence do not agree; reconcile the prior run",
    );
  await verifyReadOnly(preview, receipt, deps);
  reportRunningClaim(receipt, claim.value, {}, owner.kind === "running");
  return receipt;
}

async function reconcileMessages(
  preview: ReadyPreview,
  receipt: PublicationReceipt,
  deps: PublicationDependencies,
) {
  for (let index = 0; index < receipt.messages.length; index++) {
    const message = receipt.messages[index];
    const observed = await observe(preview, index, deps);
    if (observed === preview.targets[index].afterFingerprint)
      updateMessage(message, "verified", observed, null, deps);
    else if (message.state === "submitted" || message.state === "uncertain")
      updateMessage(
        message,
        "uncertain",
        observed,
        "Unresolved edit; operator assertion cannot clear uncertainty",
        deps,
      );
    else
      updateMessage(
        message,
        message.state === "verified" ? "failed" : message.state,
        observed,
        "No matching content observed; confirm the prior process stopped before releasing its claim",
        deps,
      );
  }
}

function reportRunningClaim(
  receipt: PublicationReceipt,
  claim: PublicationClaim,
  options: PublicationReconcileOptions,
  databaseRunning = false,
) {
  if (
    (claim.state === "running" || databaseRunning) &&
    options.confirmRunStopped === undefined &&
    unresolved(receipt).length === 0
  ) {
    if (receipt.status === "verified") receipt.status = "running";
    for (const message of receipt.messages)
      message.reason ??= `Claim remains running; confirm process ${receipt.runId} has stopped before releasing it`;
  }
}

export async function reconcileRecoveryDiscordPublication(
  input: RecoveryDiscordPreview,
  deps: PublicationDependencies,
  options: PublicationReconcileOptions = {},
): Promise<PublicationReceipt> {
  const preview = await validatePreview(input, deps, false);
  const { receipt, saved, claim, owner } = await loadReconciliation(
    preview,
    deps,
  );
  if (
    options.confirmRunStopped !== undefined &&
    options.confirmRunStopped !== receipt.runId
  )
    throw new Error(
      "Stopped-run assertion must identify the exact claim owner",
    );
  if (
    receipt.status === "verified" &&
    claim.value.state === "terminal" &&
    owner.kind === "settled"
  )
    return verifyReadOnly(preview, receipt, deps);
  await reconcileMessages(preview, receipt, deps);
  await finish(preview, receipt, deps);
  reportRunningClaim(receipt, claim.value, options, owner.kind === "running");
  await saveReceipt(preview, receipt, saved?.etag ?? null, deps);
  const canClose =
    options.confirmRunStopped === receipt.runId &&
    unresolved(receipt).length === 0;
  await saveClaim(
    preview,
    {
      ...claim.value,
      state: canClose ? "terminal" : claim.value.state,
      unresolvedMessageIds: unresolved(receipt),
    },
    claim.etag,
    deps,
  );
  if (canClose)
    await deps.publication.settle({
      owner,
      evidence: { kind: "confirmed_stopped", runId: receipt.runId },
      adoptVerified: receipt.status === "verified",
    });
  return receipt;
}
