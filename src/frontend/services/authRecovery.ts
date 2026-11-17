import { TRPCClientError, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import type { AppRouter } from "../../trpc/router";

export type AuthTransportEvent = {
  kind: "unauthorized" | "authorized-operation" | "check";
  generation: number;
  path: string;
};
const publicPaths = new Set([
  "auth.me",
  "pricing.plans",
  "meetingShares.getPublicMeeting",
  "ask.getPublicConversation",
  "contactFeedback.getUploadUrl",
  "contactFeedback.submit",
]);
let generation = 0;
let requestsAllowed = true;
const listeners = new Set<(event: AuthTransportEvent) => void>();
export const setAuthRequestGeneration = (value: number) => {
  generation = value;
};
export const advanceAuthRequestGeneration = () => ++generation;
export const getAuthRequestGeneration = () => generation;
export const authRequestsAllowed = () => requestsAllowed;
export const reportAuthRequired = (requestGeneration: number, path: string) =>
  publish({ kind: "unauthorized", generation: requestGeneration, path });
export const reportAuthCheck = (requestGeneration: number) =>
  publish({
    kind: "check",
    generation: requestGeneration,
    path: "live.stream",
  });
export const reportAuthorizedOperation = (
  requestGeneration: number,
  path: string,
) =>
  publish({
    kind: "authorized-operation",
    generation: requestGeneration,
    path,
  });
export const setAuthRequestsAllowed = (value: boolean) => {
  requestsAllowed = value;
};
export function subscribeAuthTransport(
  listener: (event: AuthTransportEvent) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const publish = (event: AuthTransportEvent) => {
  if (event.generation === generation)
    for (const listener of listeners) listener(event);
};

export const authRecoveryLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) => {
      const current = generation;
      const protectedOperation = !publicPaths.has(op.path);
      if (protectedOperation && !requestsAllowed) {
        observer.error(new TRPCClientError("Sign-in is paused"));
        return;
      }
      return next(op).subscribe({
        next(value) {
          if (protectedOperation && current !== generation) {
            observer.error(new TRPCClientError("Session changed"));
            return;
          }
          if (protectedOperation)
            publish({
              kind: "authorized-operation",
              generation: current,
              path: op.path,
            });
          observer.next(value);
        },
        error(error) {
          if (protectedOperation && error.data?.code === "UNAUTHORIZED")
            publish({
              kind: "unauthorized",
              generation: current,
              path: op.path,
            });
          observer.error(error);
        },
        complete: () => observer.complete(),
      });
    });

const recoveryKey = "chronote.auth-recovery";
const attemptSchema = z.object({
  id: z.string().min(1).max(128),
  destination: z.string(),
  expiresAt: z.number(),
});
export type RecoveryAttempt = z.infer<typeof attemptSchema>;
export function readRecoveryAttempt(): RecoveryAttempt | null {
  try {
    const raw = sessionStorage.getItem(recoveryKey);
    if (!raw) return null;
    const parsed = attemptSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.expiresAt > Date.now()
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}
export function clearRecoveryAttempt() {
  try {
    sessionStorage.removeItem(recoveryKey);
  } catch {
    /* Explicit recovery remains available when storage is blocked. */
  }
}
export function createRecoveryUrl(
  loginUrl: string,
  explicit = false,
): string | undefined {
  const url = new URL(loginUrl, window.location.href);
  const destination = url.searchParams.get("redirect") ?? window.location.href;
  if (!explicit && readRecoveryAttempt()) return undefined;
  const attempt: RecoveryAttempt = {
    id: crypto.randomUUID(),
    destination,
    expiresAt: Date.now() + 10 * 60_000,
  };
  try {
    sessionStorage.setItem(recoveryKey, JSON.stringify(attempt));
  } catch {
    if (!explicit) return undefined;
  }
  url.searchParams.set("authRecovery", attempt.id);
  if (explicit) url.searchParams.set("interaction", "consent");
  return url.toString();
}

export function readRecoveryOutcome(): "ok" | "failed" | null {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("authOutcome");
  if (outcome === "failed") return "failed";
  return outcome === "ok" &&
    url.searchParams.get("authRecovery") === readRecoveryAttempt()?.id
    ? "ok"
    : null;
}
export function removeRecoveryOutcome() {
  const url = new URL(window.location.href);
  url.searchParams.delete("authRecovery");
  url.searchParams.delete("authOutcome");
  window.history.replaceState(window.history.state, "", url);
}

const blockers = new Set<symbol>();
const blockerListeners = new Set<() => void>();
export const hasAuthNavigationBlockers = () => blockers.size > 0;
export function subscribeAuthNavigationBlockers(listener: () => void) {
  blockerListeners.add(listener);
  return () => {
    blockerListeners.delete(listener);
  };
}
export function registerAuthNavigationBlocker() {
  const id = Symbol();
  blockers.add(id);
  for (const listener of blockerListeners) listener();
  return () => {
    blockers.delete(id);
    for (const listener of blockerListeners) listener();
  };
}

export function navigateToDiscord(url: string) {
  window.location.assign(url);
}
