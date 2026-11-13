import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { TASK_PROTECTION_FAILED_LOG, workerTaskProtections } from "../metrics";
import { config } from "./configService";
import { LIFECYCLE, RUNTIME_AGENT_TIMEOUT_MS } from "./lifecycleTiming";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

const protectionResponse = z.object({
  protection: z.object({
    TaskArn: z.string(),
    ProtectionEnabled: z.boolean(),
    ExpirationDate: z.string().datetime({ offset: true }).nullable(),
  }),
});

type TaskProtectionState =
  | { ProtectionEnabled: true; ExpiresInMinutes: number }
  | { ProtectionEnabled: false };

/** One PUT to the ECS agent task protection endpoint. The caller interprets the body. */
async function requestTaskProtectionState(options: {
  agentUri: string;
  request: typeof fetch;
  state: TaskProtectionState;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await options.request(
    `${options.agentUri.replace(/\/$/, "")}/task-protection/v1/state`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options.state),
      signal: AbortSignal.any([
        AbortSignal.timeout(RUNTIME_AGENT_TIMEOUT_MS),
        ...(options.signal ? [options.signal] : []),
      ]),
    },
  );
  const body: unknown = await response.json();
  return { ok: response.ok, status: response.status, body };
}

type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;
type AgentReply = {
  protection?: z.infer<typeof protectionResponse>["protection"];
  detail?: string;
};

const agentFailure = z.object({ failure: z.object({ Reason: z.string() }) });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const unrefSleep: Sleep = (ms, signal) =>
  delay(ms, undefined, { signal, ref: false });

export type TaskProtection = ReturnType<typeof createTaskProtection>;

/**
 * ECS scale-in protection for live captures. A failed call is logged and
 * counted but never thrown, because losing protection is never a reason to stop.
 */
export function createTaskProtection(deps: {
  agentUri: string;
  request?: typeof fetch;
  /** Epoch seconds. */
  now?: () => number;
  sleep?: Sleep;
  /** Epoch seconds of the latest cap over unexpired leases, or undefined when none is live. */
  latestLeaseCap(now: number): number | undefined;
}) {
  const request = deps.request ?? fetch;
  const now = deps.now ?? (() => Math.floor(Date.now() / MS_PER_SECOND));
  const sleep = deps.sleep ?? unrefSleep;
  let confirmedUntil: number | undefined;
  let captureRetry: AbortController | undefined;
  let clearing: AbortController | undefined;
  /** Every PUT waits for the previous one, so an enable never overtakes a later disable. */
  let previousPut: Promise<unknown> = Promise.resolve();

  async function sendPut(
    state: TaskProtectionState,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    try {
      const { ok, status, body } = await requestTaskProtectionState({
        agentUri: deps.agentUri,
        request,
        state,
        signal,
      });
      const parsed = protectionResponse.safeParse(body);
      if (ok && parsed.success) return { protection: parsed.data.protection };
      const refusal = agentFailure.safeParse(body);
      return {
        detail: refusal.success
          ? `status ${status} ${refusal.data.failure.Reason}`
          : `status ${status}`,
      };
    } catch (error) {
      return { detail: describeError(error) };
    }
  }

  function put(
    state: TaskProtectionState,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    const reply = previousPut.then(() => sendPut(state, signal));
    previousPut = reply;
    return reply;
  }

  function record(
    succeeded: boolean,
    detail: string,
    signal?: AbortSignal,
  ): boolean {
    if (signal?.aborted) return false;
    workerTaskProtections.inc({ outcome: succeeded ? "success" : "failure" });
    // The log metric filter matches the fixed token, so it stays at the start.
    if (!succeeded) console.error(`${TASK_PROTECTION_FAILED_LOG}: ${detail}`);
    return succeeded;
  }

  async function ensure(signal?: AbortSignal): Promise<boolean> {
    if (!deps.agentUri) return false;
    let reply: AgentReply;
    try {
      const at = now();
      const cap = deps.latestLeaseCap(at);
      if (cap === undefined) return false;
      reply = await put(
        {
          ProtectionEnabled: true,
          ExpiresInMinutes: Math.ceil(
            (cap + LIFECYCLE.protectionPastCapSeconds - at) /
              SECONDS_PER_MINUTE,
          ),
        },
        signal,
      );
    } catch (error) {
      reply = { detail: describeError(error) };
    }
    const expiresAt = Math.floor(
      Date.parse(reply.protection?.ExpirationDate ?? "") / MS_PER_SECOND,
    );
    const succeeded =
      reply.protection?.ProtectionEnabled === true &&
      Number.isFinite(expiresAt);
    if (succeeded && !signal?.aborted) confirmedUntil = expiresAt;
    return record(succeeded, reply.detail ?? "unconfirmed expiry", signal);
  }

  async function disable(signal: AbortSignal): Promise<boolean> {
    const reply = await put({ ProtectionEnabled: false }, signal);
    const succeeded = reply.protection?.ProtectionEnabled === false;
    if (succeeded && !signal.aborted) confirmedUntil = undefined;
    return record(succeeded, reply.detail ?? "still enabled", signal);
  }

  async function retryAfterFirst(
    attempt: (signal: AbortSignal) => Promise<boolean>,
    signal: AbortSignal,
    firstSucceeded: boolean,
  ) {
    let succeeded = firstSucceeded;
    while (!succeeded && !signal.aborted) {
      try {
        await sleep(LIFECYCLE.protectionRetryMs, signal);
      } catch {
        return;
      }
      succeeded = await attempt(signal);
    }
  }

  function restart(controller: AbortController | undefined) {
    controller?.abort();
    return new AbortController();
  }

  async function clear(): Promise<void> {
    if (!deps.agentUri) return;
    clearing = restart(clearing);
    const { signal } = clearing;
    await retryAfterFirst(disable, signal, await disable(signal));
  }

  return {
    ensure,
    clear,
    protectedUntil: () => confirmedUntil,
    /** Asks once, then keeps retrying in the background until covered or released. */
    async requestCapture(): Promise<void> {
      if (!deps.agentUri) return;
      clearing?.abort();
      captureRetry = restart(captureRetry);
      const { signal } = captureRetry;
      void retryAfterFirst(ensure, signal, await ensure(signal));
    },
    releaseCapture(): Promise<void> {
      captureRetry?.abort();
      return clear();
    },
  };
}

let captureProtection: TaskProtection | undefined;

/** Called once at start-up. Until then the singleton behaves as if no lease is live. */
export function configureCaptureProtection(deps: {
  latestLeaseCap(now: number): number | undefined;
}): void {
  captureProtection = createTaskProtection({
    agentUri: config.runtime.agentUri,
    latestLeaseCap: deps.latestLeaseCap,
  });
}

/** Called before joining voice. Never throws. */
export async function requestCaptureProtection(): Promise<void> {
  await captureProtection?.requestCapture();
}

/** Called when the last capture closes. */
export function releaseCaptureProtection(): void {
  void captureProtection?.releaseCapture();
}

export function getProtectedUntil(): number | undefined {
  return captureProtection?.protectedUntil();
}
