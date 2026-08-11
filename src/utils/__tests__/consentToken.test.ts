import { describe, expect, test } from "@jest/globals";
import { readConsentToken, signConsentToken } from "../consentToken";

type TestPayload = { expiresAt: number; userId: string };

const isTestPayload = (value: unknown): value is TestPayload => {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<TestPayload>;
  return (
    typeof payload.expiresAt === "number" && typeof payload.userId === "string"
  );
};

const SECRET = "consent-secret";
const NOW = 1_000_000;

describe("consent token", () => {
  test("round trips a payload", () => {
    const token = signConsentToken(
      { expiresAt: NOW + 1000, userId: "user-1" },
      SECRET,
    );

    expect(readConsentToken(token, SECRET, isTestPayload, NOW)).toEqual({
      expiresAt: NOW + 1000,
      userId: "user-1",
    });
  });

  test("rejects a payload signed with a different secret", () => {
    const token = signConsentToken(
      { expiresAt: NOW + 1000, userId: "user-1" },
      "other-secret",
    );

    expect(readConsentToken(token, SECRET, isTestPayload, NOW)).toBeUndefined();
  });

  test("rejects a tampered payload", () => {
    const token = signConsentToken(
      { expiresAt: NOW + 1000, userId: "user-1" },
      SECRET,
    );
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ expiresAt: NOW + 1000, userId: "attacker" }),
      "utf8",
    ).toString("base64url");

    expect(
      readConsentToken(`${forged}.${signature}`, SECRET, isTestPayload, NOW),
    ).toBeUndefined();
  });

  test("rejects an expired payload", () => {
    const token = signConsentToken(
      { expiresAt: NOW, userId: "user-1" },
      SECRET,
    );

    expect(readConsentToken(token, SECRET, isTestPayload, NOW)).toBeUndefined();
  });

  test("rejects a payload of the wrong shape", () => {
    const token = signConsentToken(
      { expiresAt: NOW + 1000 } as TestPayload,
      SECRET,
    );

    expect(readConsentToken(token, SECRET, isTestPayload, NOW)).toBeUndefined();
  });

  test("rejects a malformed token", () => {
    expect(
      readConsentToken("not-a-token", SECRET, isTestPayload, NOW),
    ).toBeUndefined();
  });
});
