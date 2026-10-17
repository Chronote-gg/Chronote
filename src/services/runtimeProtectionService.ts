import { sameEcsTaskArn } from "../utils/ecsTaskArn";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ProtectionConfirmation,
  RuntimeIdentity,
} from "../types/deploymentControl";

export const RUNTIME_PROTECTION_MINUTES = 10;
export const RUNTIME_PROTECTION_RENEWAL_MS = 60_000;
export const RUNTIME_PROTECTION_MARGIN_SECONDS = 120;
export const RUNTIME_AGENT_TIMEOUT_MS = 5_000;
const protectionResponse = z.object({
  protection: z.object({
    TaskArn: z.string(),
    ProtectionEnabled: z.boolean(),
    ExpirationDate: z.string().datetime({ offset: true }).nullable(),
  }),
});
const blockedResponse = z.object({
  failure: z.object({
    Arn: z.string(),
    Reason: z.literal("DEPLOYMENT_BLOCKED"),
  }),
});
class InitialProtectionBlocked extends Error {}

export type RuntimeProtectionService = ReturnType<
  typeof createRuntimeProtectionService
>;

/** Only the owning runtime uses this adapter. A coordinator never releases protection. */
export function createRuntimeProtectionService(options: {
  identity: RuntimeIdentity;
  agentUri?: string;
  request?: typeof fetch;
  now?: () => number;
  onUnsafe: () => void | Promise<void>;
  signal?: AbortSignal;
  initialRetry?: (signal: AbortSignal) => Promise<void>;
}) {
  const { identity } = options;
  const request = options.request ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  let confirmation: ProtectionConfirmation | undefined;
  let renewal: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let unsafeHandler = options.onUnsafe;
  let stopped = false;
  let closing = false;
  let tail: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation);
    tail = next.catch(() => undefined);
    return next;
  }
  function stop() {
    stopped = true;
    clearInterval(renewal);
    clearTimeout(deadline);
    renewal = undefined;
    deadline = undefined;
  }
  function armDeadline() {
    clearTimeout(deadline);
    if (!confirmation || stopped) return;
    deadline = setTimeout(
      () => {
        void Promise.resolve()
          .then(unsafeHandler)
          .catch(() =>
            console.error("Runtime protection safety handler failed"),
          );
      },
      Math.max(
        0,
        (confirmation.expiresAt - now() - RUNTIME_PROTECTION_MARGIN_SECONDS) *
          1000,
      ),
    );
    deadline.unref();
  }
  async function requestState(enabled: boolean, signal?: AbortSignal) {
    if (!options.agentUri) throw new Error("ECS agent URI is required");
    const response = await request(
      `${options.agentUri.replace(/\/$/, "")}/task-protection/v1/state`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          enabled
            ? {
                ProtectionEnabled: true,
                ExpiresInMinutes: RUNTIME_PROTECTION_MINUTES,
              }
            : { ProtectionEnabled: false },
        ),
        signal: AbortSignal.any([
          AbortSignal.timeout(RUNTIME_AGENT_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    const body: unknown = await response.json();
    const blocked = blockedResponse.safeParse(body);
    if (
      blocked.success &&
      identity.kind === "ecs" &&
      sameEcsTaskArn(blocked.data.failure.Arn, identity.taskArn)
    )
      throw new InitialProtectionBlocked(
        "Initial task protection blocked by deployment",
      );
    if (!response.ok) throw new Error("ECS protection request failed");
    return protectionResponse.parse(body).protection;
  }
  async function validateState(
    protection: z.infer<typeof protectionResponse>["protection"],
    enabled: boolean,
  ) {
    if (identity.kind !== "ecs") throw new Error("Expected ECS identity");
    const expiresAt = Math.floor(
      Date.parse(protection.ExpirationDate ?? "") / 1000,
    );
    if (
      enabled &&
      sameEcsTaskArn(protection.TaskArn, identity.taskArn) &&
      (!protection.ProtectionEnabled ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now() + RUNTIME_PROTECTION_MARGIN_SECONDS)
    ) {
      confirmation = undefined;
      clearTimeout(deadline);
      await unsafeHandler();
      throw new Error("Exact task protection disabled or unsafe");
    }
    if (
      !sameEcsTaskArn(protection.TaskArn, identity.taskArn) ||
      protection.ProtectionEnabled !== enabled
    )
      throw new Error("ECS protection identity or state mismatch");
    return expiresAt;
  }
  async function update(
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<ProtectionConfirmation | undefined> {
    const provenAt = now();
    if (identity.kind === "local")
      return enabled
        ? { identity, provenAt, expiresAt: provenAt + 600 }
        : undefined;
    const expiresAt = await validateState(
      await requestState(enabled, signal),
      enabled,
    );
    if (!enabled) return undefined;
    return { identity, provenAt, expiresAt };
  }
  async function confirm(
    signal?: AbortSignal,
  ): Promise<ProtectionConfirmation> {
    return serialize(async () => {
      if (stopped) throw new Error("Runtime protection is stopped");
      const proof = await update(true, signal);
      if (stopped) throw new Error("Runtime protection is stopped");
      if (!proof) throw new Error("Protection confirmation missing");
      confirmation = proof;
      armDeadline();
      return structuredClone(proof);
    });
  }
  async function start() {
    if (closing) throw new Error("Runtime protection is shutting down");
    stopped = false;
    const signal = AbortSignal.any([
      AbortSignal.timeout(900_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    const initialDeadline = now() + 900;
    while (true) {
      signal.throwIfAborted();
      try {
        await confirm(signal);
        break;
      } catch (error) {
        if (
          !(error instanceof InitialProtectionBlocked) ||
          now() >= initialDeadline
        )
          throw error;
        if (options.initialRetry) await options.initialRetry(signal);
        else await delay(10_000, undefined, { signal });
      }
    }
    if (!renewal) {
      renewal = setInterval(() => {
        void confirm().catch(() =>
          console.warn("Runtime protection renewal failed"),
        );
      }, RUNTIME_PROTECTION_RENEWAL_MS);
      renewal.unref();
    }
  }
  async function release() {
    stop();
    confirmation = undefined;
    await serialize(async () => {
      await update(false);
      confirmation = undefined;
      clearTimeout(deadline);
    });
  }
  return {
    start,
    stop,
    async shutdown() {
      closing = true;
      stop();
      await tail;
      stop();
    },
    release,
    confirm,
    getConfirmation: () =>
      confirmation ? structuredClone(confirmation) : undefined,
    isSafe: () =>
      Boolean(
        confirmation &&
        confirmation.expiresAt > now() + RUNTIME_PROTECTION_MARGIN_SECONDS,
      ),
    setUnsafeHandler(handler: () => void | Promise<void>) {
      unsafeHandler = handler;
    },
  };
}
