import { describe, expect, test } from "@jest/globals";
import { buildExpiryIso } from "../../src/frontend/pages/AdminEntitlements";

describe("admin entitlement helpers", () => {
  test("buildExpiryIso expires date-only grants at local end of day", () => {
    expect(buildExpiryIso("expires", "2026-01-02")).toBe(
      new Date(2026, 0, 2, 23, 59, 59, 999).toISOString(),
    );
  });

  test("buildExpiryIso leaves no-expiry grants unset", () => {
    expect(buildExpiryIso("none", "2026-01-02")).toBeUndefined();
  });
});
