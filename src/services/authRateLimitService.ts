import crypto from "node:crypto";
import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

type AuthRateLimitConfig = {
  enabled: boolean;
  windowMs: number;
  limit: number;
  // Count a bearer token's requests against that token rather than its IP.
  // Routes that already require a valid token should use this: an IP key makes
  // every client behind one office, school or VPN address share a single
  // allowance, which a polling client exhausts on someone else's behalf.
  // Unauthenticated routes must stay on the IP key, since that is what limits
  // guessing at tokens in the first place.
  perBearerToken?: boolean;
};

const bearerTokenKey = (authorization?: string) => {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return undefined;
  return `token:${crypto.createHash("sha256").update(token).digest("base64url")}`;
};

const passThrough: RequestHandler = (_req, _res, next) => {
  next();
};

export const createAuthRateLimiter = ({
  enabled,
  windowMs,
  limit,
  perBearerToken = false,
}: AuthRateLimitConfig): RequestHandler => {
  if (!enabled) {
    return passThrough;
  }

  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: "Too many authentication attempts, please try again later.",
    ...(perBearerToken
      ? {
          keyGenerator: (req) =>
            bearerTokenKey(req.headers.authorization) ??
            ipKeyGenerator(req.ip ?? ""),
        }
      : {}),
  });
};
