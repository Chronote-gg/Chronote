import { isDeepStrictEqual } from "node:util";
import type { MeetingData } from "../types/meeting-data";
import type { SessionReservation } from "../types/deploymentControl";
import { fixtureGrantSchema } from "../types/productionIntroduction";
import { fixtureScopeForGrant } from "./deploymentFixtureAdmission";
import type {
  FixtureFailure,
  FixtureInputEvidence,
  FixtureGenerationEvidence,
  FixtureTranscriptEvidence,
  GenerationObserver,
} from "../types/fixtureEvidence";
import { fixtureGenerationSchema } from "../types/fixtureEvidence";
import type { Participant } from "../types/participants";

type Carrier = { reservation?: SessionReservation };
type State = {
  input: FixtureInputEvidence;
  generation: FixtureGenerationEvidence;
  transcript?: FixtureTranscriptEvidence;
  dispose?: () => void;
  closing: boolean;
  attached: boolean;
};
const fixtures = new WeakMap<SessionReservation, State>();
function stateFor(meeting: Carrier) {
  return meeting.reservation ? fixtures.get(meeting.reservation) : undefined;
}
export function isFixture(meeting: Carrier): boolean {
  return Boolean(stateFor(meeting));
}
export async function verifyFixtureReservation(
  reservation: SessionReservation,
): Promise<void> {
  const { originalFixtureScope } = await import("./activeMeetingLeaseService");
  const scope = originalFixtureScope(reservation);
  if (!scope) return;
  if (fixtures.has(reservation))
    throw new Error("Fixture receiver cannot reattach");
  const { getDeploymentControlRepository } = await import("../db");
  const grant = fixtureGrantSchema.parse(
    await getDeploymentControlRepository().getRecord(
      `FIXTURE#${scope.reference.grantId}`,
      "AUTHORITY",
    ),
  );
  const ownership = {
    guildId: reservation.guildId,
    meetingId: reservation.meetingId,
    ownerInstanceId: reservation.ownerInstanceId,
    executionVersion: reservation.executionVersion,
    voiceOperationAttemptId: reservation.voiceOperationAttemptId,
    sessionMode: reservation.sessionMode,
  };
  if (
    grant.state !== "consumed" ||
    reservation.sessionMode !== "meeting" ||
    !isDeepStrictEqual(fixtureScopeForGrant(grant), scope) ||
    !isDeepStrictEqual(grant.ownership, ownership) ||
    !isDeepStrictEqual(grant.historyKey, reservation.historyKey)
  )
    throw new Error("Consumed fixture reservation mismatch");
  fixtures.set(reservation, {
    closing: false,
    attached: false,
    input: {
      schemaVersion: 1,
      profile: "manual_script_v1",
      reference: scope.reference,
      commandId: grant.commandId,
      actorUserId: grant.actorUserId,
      scriptSha256: grant.scriptSha256,
      checklistSha256: grant.checklistSha256,
      ownership: grant.ownership,
      historyKey: grant.historyKey,
      observationStartedAt: null,
      captureStartedAt: null,
      captureEndedAt: null,
      observationEndedAt: null,
      acceptedSourceId: `user:${grant.actorUserId}`,
      acceptedPcmChunks: 0,
      acceptedPcmBytes: 0,
      unexpectedMembers: 0,
      unexpectedSourceAttempts: 0,
      rejectedMessages: 0,
      rejectedAttachments: 0,
      ttsAttempts: 0,
      continuityFailures: 0,
      overflow: false,
      state: "observing",
      failureReasons: [],
    },
    generation: {
      schemaVersion: 1,
      submitted: 0,
      acknowledged: 0,
      missing: 0,
      overflow: false,
      tuples: [],
    },
  });
}
function increment(
  state: State,
  field:
    | "acceptedPcmChunks"
    | "acceptedPcmBytes"
    | "unexpectedMembers"
    | "unexpectedSourceAttempts"
    | "rejectedMessages"
    | "rejectedAttachments"
    | "ttsAttempts"
    | "continuityFailures",
  amount = 1,
) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    state.input[field] > Number.MAX_SAFE_INTEGER - amount
  ) {
    state.input[field] = Number.MAX_SAFE_INTEGER;
    state.input.overflow = true;
    fail(state, "counter_overflow");
  } else state.input[field] += amount;
}
function fail(state: State, reason: FixtureFailure) {
  if (!state.input.failureReasons.includes(reason))
    state.input.failureReasons.push(reason);
  const contamination = [
    "unbound_member",
    "unbound_audio",
    "chat_input",
    "tts_input",
    "input_profile_mismatch",
  ].includes(reason);
  if (contamination || state.input.state !== "contaminated")
    state.input.state = contamination ? "contaminated" : "incomplete";
}
export function failFixture(meeting: Carrier, reason: FixtureFailure) {
  const state = stateFor(meeting);
  if (!state) return;
  fail(state, reason);
  if (
    [
      "observer_gap",
      "decoder_failure",
      "ownership_lost",
      "reattachment",
    ].includes(reason)
  )
    increment(state, "continuityFailures");
}
export function fixtureInputSnapshot(meeting: Carrier) {
  const state = stateFor(meeting);
  return state ? structuredClone(state.input) : undefined;
}
export function fixtureParticipant(
  meeting: Carrier,
  id: string,
): Participant | undefined {
  const state = stateFor(meeting);
  if (!state || state.input.actorUserId !== id) return undefined;
  return {
    id,
    username: "fixture-speaker",
    displayName: "Fixture speaker",
    serverNickname: "Fixture speaker",
    roleIds: [],
  };
}
export function fixtureParticipants(
  meeting: Carrier,
): Participant[] | undefined {
  const state = stateFor(meeting);
  return state
    ? [fixtureParticipant(meeting, state.input.actorUserId)!]
    : undefined;
}
export function allowFixtureActor(meeting: Carrier, id: string): boolean {
  const state = stateFor(meeting);
  if (!state) return true;
  if (id !== state.input.actorUserId) {
    increment(state, "unexpectedSourceAttempts");
    fail(state, "unbound_audio");
    return false;
  }
  if (state.closing || state.input.observationEndedAt) {
    fail(state, "incomplete_closure");
    return false;
  }
  return true;
}
export function observeFixtureMember(
  meeting: Carrier,
  id: string,
  present: boolean,
  botId: string,
) {
  const state = stateFor(meeting);
  if (!state || state.closing) return;
  if (id === botId) return;
  if (id === state.input.actorUserId) {
    if (!present) fail(state, "actor_absent");
  } else if (present) {
    increment(state, "unexpectedMembers");
    fail(state, "unbound_member");
  }
}
export function observeFixtureMessage(meeting: Carrier, attachments: number) {
  const state = stateFor(meeting);
  if (!state || state.closing) return;
  increment(state, "rejectedMessages");
  increment(state, "rejectedAttachments", attachments);
  fail(state, "chat_input");
}
export function rejectFixtureTts(meeting: Carrier): boolean {
  const state = stateFor(meeting);
  if (!state) return false;
  increment(state, "ttsAttempts");
  fail(state, "tts_input");
  return true;
}
export function armFixtureObservation(meeting: Carrier, dispose: () => void) {
  const state = stateFor(meeting);
  if (!state) return;
  if (state.dispose || state.input.observationStartedAt) {
    fail(state, "reattachment");
    throw new Error("Fixture observation already armed");
  }
  state.dispose = dispose;
  state.input.observationStartedAt = new Date().toISOString();
}
export function startFixtureCapture(meeting: Carrier, startedAt: Date) {
  const state = stateFor(meeting);
  if (!state) return;
  if (state.attached || !state.input.observationStartedAt || state.closing) {
    fail(state, "reattachment");
    return;
  }
  state.attached = true;
  state.input.captureStartedAt = startedAt.toISOString();
}
export function acceptedFixturePcm(meeting: Carrier, bytes: number) {
  const state = stateFor(meeting);
  if (!state) return;
  if (!state.attached || !state.input.observationStartedAt || state.closing) {
    fail(state, "observer_gap");
    return;
  }
  increment(state, "acceptedPcmChunks");
  increment(state, "acceptedPcmBytes", bytes);
}
export function beginFixtureClosure(meeting: Carrier) {
  const state = stateFor(meeting);
  if (state) state.closing = true;
}
export function closeFixtureObservation(
  meeting: Carrier,
  endedAt: string,
  complete: boolean,
) {
  const state = stateFor(meeting);
  if (!state || state.input.observationEndedAt) return;
  if (!state.closing || !state.attached || !state.dispose || !complete)
    fail(state, "incomplete_closure");
  state.input.captureEndedAt = endedAt;
  state.dispose?.();
  state.dispose = undefined;
  state.input.observationEndedAt = new Date().toISOString();
  if (state.input.state === "observing") state.input.state = "closed";
}
export function assertFixtureFinalization(
  meeting: Pick<
    MeetingData,
    "reservation" | "chatLog" | "dictionaryEntries" | "meetingContext" | "tags"
  >,
) {
  const state = stateFor(meeting);
  if (!state) return;
  if (
    meeting.chatLog.length ||
    meeting.dictionaryEntries?.length ||
    meeting.meetingContext ||
    meeting.tags?.length
  )
    fail(state, "input_profile_mismatch");
  if (!state.closing || !state.input.observationEndedAt)
    fail(state, "incomplete_closure");
}
export const fixtureLabels = {
  serverName: "Chronote fixture",
  voiceChannelName: "Fixture voice",
  attendees: "Fixture speaker",
  botDisplayName: "Chronote",
};
function incrementGeneration(
  generation: FixtureGenerationEvidence,
  key: "missing" | "acknowledged",
) {
  if (generation[key] === Number.MAX_SAFE_INTEGER) generation.overflow = true;
  else generation[key]++;
}
export function fixtureGenerationObserver(
  meeting: Carrier,
): GenerationObserver | undefined {
  const state = stateFor(meeting);
  if (!state) return undefined;
  return (stage, requestedModel, prompt) => {
    const generation = state.generation;
    if (generation.submitted === Number.MAX_SAFE_INTEGER) {
      generation.overflow = true;
      return () => {};
    }
    generation.submitted++;
    let acknowledged = false;
    return (returnedModel) => {
      if (acknowledged) {
        incrementGeneration(generation, "missing");
        return;
      }
      acknowledged = true;
      incrementGeneration(generation, "acknowledged");
      const tuple = {
        stage,
        requestedModel,
        returnedModel,
        providerRevision: "unavailable" as const,
        prompt:
          prompt === null
            ? { kind: "none" as const }
            : prompt
              ? {
                  kind: "resolved" as const,
                  name: prompt.name,
                  version: prompt.version,
                  fallback: prompt.isFallback ?? false,
                }
              : { kind: "missing" as const },
        count: 1,
      };
      const checked =
        fixtureGenerationSchema.shape.tuples.element.safeParse(tuple);
      if (!checked.success) {
        incrementGeneration(generation, "missing");
        return;
      }
      if (!prompt && prompt !== null)
        incrementGeneration(generation, "missing");
      if (returnedModel === null && !stage.startsWith("transcription-audio"))
        incrementGeneration(generation, "missing");
      const existing = generation.tuples.find((item) =>
        isDeepStrictEqual({ ...item, count: 1 }, checked.data),
      );
      if (existing) existing.count++;
      else if (generation.tuples.length < 64)
        generation.tuples.push(checked.data);
      else generation.overflow = true;
    };
  };
}
export function recordFixtureTranscript(
  meeting: Carrier,
  receipt: FixtureTranscriptEvidence,
) {
  const state = stateFor(meeting);
  if (state) state.transcript = structuredClone(receipt);
}
export function fixtureOutputSnapshot(meeting: Carrier) {
  const state = stateFor(meeting);
  return state
    ? {
        fixtureInput: structuredClone(state.input),
        fixtureGeneration: structuredClone(state.generation),
        ...(state.transcript
          ? { fixtureTranscript: structuredClone(state.transcript) }
          : {}),
      }
    : {};
}
