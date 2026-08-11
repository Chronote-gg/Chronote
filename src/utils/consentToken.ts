import crypto from "node:crypto";

// A consent token carries an authorization request through the consent page and
// back, so the browser round trip cannot alter what is being approved. It is
// signed rather than stored: the payload is short lived and single use, and the
// session nonce inside it is what ties an approval to the browser that started
// the flow.
//
// `src/api/mcpOAuth.ts` has an equivalent codec of its own. It is deliberately
// not migrated here yet, because that consent path has no test coverage and
// this is not the change to refactor it under.

type ExpiringPayload = { expiresAt: number };

const sign = (payload: string, secret: string) =>
  crypto.createHmac("sha256", secret).update(payload).digest("base64url");

const signaturesMatch = (actual: string, expected: string) => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export const signConsentToken = <T extends ExpiringPayload>(
  request: T,
  secret: string,
) => {
  const payload = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
};

export const readConsentToken = <T extends ExpiringPayload>(
  token: string,
  secret: string,
  isValid: (value: unknown) => value is T,
  now = Date.now(),
): T | undefined => {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  if (!signaturesMatch(signature, sign(payload, secret))) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    if (!isValid(parsed)) return undefined;
    if (parsed.expiresAt <= now) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};
