import type { Request } from "express";
import {
  consumeMcpConsentNonce,
  stashMcpConsentNonce,
} from "../mcpOAuthSession";

describe("mcpOAuthSession", () => {
  it("consumes consent nonces exactly once", () => {
    const req = { session: {} } as Request;

    expect(stashMcpConsentNonce(req, "nonce-1")).toBe(true);
    expect(consumeMcpConsentNonce(req)).toBe("nonce-1");
    expect(consumeMcpConsentNonce(req)).toBeUndefined();
  });
});
