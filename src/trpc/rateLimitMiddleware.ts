import { TRPCError, initTRPC } from "@trpc/server";
import type { TrpcContext } from "./context";

// Separate initTRPC instance to avoid pulling the full dependency chain from
// trpc.ts (permissions -> guildAccess -> discordService). The middleware is a
// plain function wrapper so it inherits the error formatter from the main
// instance at runtime.
const t = initTRPC.context<TrpcContext>().create();

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

// Best-effort in-memory rate limiter. Resets on deploy/restart and is
// per-process, so it does not provide guarantees in multi-instance ECS.
const ipBuckets = new Map<string, RateLimitEntry>();

const CLEANUP_INTERVAL_MS = 60_000;

let cleanupTimer: NodeJS.Timeout | undefined;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of ipBuckets) {
      if (entry.resetAt <= now) {
        ipBuckets.delete(ip);
      }
    }
    if (ipBuckets.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = undefined;
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
}

/**
 * Check rate limit for an IP. Returns true if allowed, false if exceeded.
 * Exported for testing.
 */
export function checkRateLimit(
  ip: string,
  windowMs: number,
  maxHits: number,
): boolean {
  const now = Date.now();

  let entry = ipBuckets.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + windowMs };
    ipBuckets.set(ip, entry);
    ensureCleanupTimer();
  }

  entry.count++;
  return entry.count <= maxHits;
}

export function createRateLimitMiddleware(windowMs: number, maxHits: number) {
  return t.middleware(({ ctx, next }) => {
    const ip = ctx.req.ip ?? ctx.req.socket.remoteAddress ?? "unknown";

    if (!checkRateLimit(ip, windowMs, maxHits)) {
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many submissions. Please try again later.",
      });
    }

    return next();
  });
}

/** Visible for testing */
export function _resetRateLimitState() {
  ipBuckets.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
}
