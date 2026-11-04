import {
  initialMeetingUpdatePolicy,
  publicationSnapshot,
} from "../types/meetingPublication";
import { randomUUID } from "node:crypto";
import type { MeetingHistory } from "../types/db";
import type {
  MeetingContentWrite,
  MeetingUpdateDeliveryRepository,
} from "../repositories/meetingUpdateDeliveryRepository";
import { getMeetingUpdateDeliveryRepository } from "../db";
import {
  readMeetingUpdateRevisions,
  requestMeetingUpdateDelivery,
  type MeetingUpdateKey,
  type MeetingUpdateMutation,
} from "../types/meetingUpdateDelivery";
import type { RuntimeApiOperation } from "./runtimeApiOperationService";
import { assertNotionOutcomeKnown } from "./notionOperationLifetime";
import { maybeAutoSyncMeetingNotes } from "./notionAutomationService";
import { verifyMeetingUpdateDeliveryReadiness } from "./meetingUpdateDeliveryWorkerService";
import {
  projectMeetingUpdateDelivery,
  type MeetingUpdatePublicDelivery,
} from "./meetingUpdateStatus";

type NotesEdit = NonNullable<MeetingContentWrite["notesEdit"]>;
export type MeetingUpdateActionInput = {
  key: MeetingUpdateKey;
  mutation: MeetingUpdateMutation;
  actor: Pick<NotesEdit, "editedBy">;
  notesEdit?: Omit<NotesEdit, "editedBy">;
  regeneration?: MeetingContentWrite["regeneration"];
  signal?: AbortSignal;
  operation?: RuntimeApiOperation;
};
export type MeetingUpdateActionResult =
  | { kind: "conflict" }
  | {
      kind: "saved";
      history: MeetingHistory;
      delivery: MeetingUpdatePublicDelivery;
    };
type Dependencies = {
  repository: MeetingUpdateDeliveryRepository;
  ready(): Promise<void>;
  syncNotes: typeof maybeAutoSyncMeetingNotes;
};
async function syncAcknowledgedNotes(input: {
  deps: Dependencies;
  action: MeetingUpdateActionInput;
  saved: MeetingHistory;
  signal: AbortSignal | undefined;
  read: RuntimeApiOperation["read"];
}): Promise<void> {
  if (!input.action.notesEdit) return;
  const { deps, action, saved, signal, read } = input;
  try {
    const current = await read(() =>
      deps.repository.getStrong(action.key, signal),
    );
    if (!current) return;
    signal?.throwIfAborted();
    await deps.syncNotes(current, signal);
  } catch (error) {
    assertNotionOutcomeKnown(error, signal);
    console.warn("Failed to sync Notion after notes update", {
      guildId: action.key.guildId,
      meetingId: saved.meetingId,
      error,
    });
  }
}

function expectedNotesVersionMoved(
  input: MeetingUpdateActionInput,
  notesVersion: number,
): boolean {
  return [
    input.notesEdit?.expectedNotesVersion,
    input.regeneration?.expected.expectedNotesVersion,
  ].some((expected) => expected !== undefined && expected !== notesVersion);
}

/**
 * A regeneration names only a meeting that is still unnamed in the row this
 * write is conditioned on, so a rename committed before the write wins.
 */
function mutationForRow(
  mutation: MeetingUpdateMutation,
  before: MeetingHistory,
): MeetingUpdateMutation {
  if (mutation.kind !== "regeneration" || !before.meetingName?.trim())
    return mutation;
  return {
    ...mutation,
    changes: mutation.changes.filter((change) => change.kind !== "rename"),
  };
}

export function createMeetingUpdateService(deps: Dependencies) {
  return async function updateMeeting(
    input: MeetingUpdateActionInput,
  ): Promise<MeetingUpdateActionResult> {
    const signal = input.signal ?? input.operation?.signal;
    const read = <T>(run: () => Promise<T>) =>
      input.operation ? input.operation.read(run) : run();
    signal?.throwIfAborted();
    const before = await read(() =>
      deps.repository.getStrong(input.key, signal),
    );
    if (!before) return { kind: "conflict" };
    const revisions = readMeetingUpdateRevisions(before);
    if (expectedNotesVersionMoved(input, revisions.notesVersion))
      return { kind: "conflict" };
    await read(() => deps.ready());
    signal?.throwIfAborted();
    const mutation = mutationForRow(input.mutation, before);
    const at = Math.floor(Date.now() / 1000);
    const write: MeetingContentWrite = {
      key: input.key,
      expectedContentRevision: revisions.contentRevision,
      expectedPublication: publicationSnapshot(before),
      expectedDeliveryRevision: before.updateDelivery?.revision ?? null,
      mutation,
      mutationId: randomUUID(),
      at,
      nextDelivery: requestMeetingUpdateDelivery({
        history: before,
        mutation,
        revision: randomUUID(),
        now: at,
        policy: initialMeetingUpdatePolicy(before),
      }),
      ...(input.notesEdit
        ? { notesEdit: { ...input.notesEdit, ...input.actor } }
        : {}),
      regeneration: input.regeneration,
    };
    const result = await (input.operation
      ? input.operation.mutate(() =>
          deps.repository.updateContentAndDelivery(write, signal),
        )
      : deps.repository.updateContentAndDelivery(write, signal));
    if (result.kind === "conflict") return result;
    signal?.throwIfAborted();
    await syncAcknowledgedNotes({
      deps,
      action: input,
      saved: result.history,
      signal,
      read,
    });
    return {
      kind: "saved",
      history: result.history,
      delivery: projectMeetingUpdateDelivery(result.history),
    };
  };
}
export async function updateMeeting(
  input: MeetingUpdateActionInput,
): Promise<MeetingUpdateActionResult> {
  return createMeetingUpdateService({
    repository: getMeetingUpdateDeliveryRepository(),
    ready: verifyMeetingUpdateDeliveryReadiness,
    syncNotes: maybeAutoSyncMeetingNotes,
  })(input);
}
