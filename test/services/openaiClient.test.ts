import { createHmac } from "node:crypto";
import { buildOpenAISafetyIdentifier } from "../../src/services/openaiClient";

describe("buildOpenAISafetyIdentifier", () => {
  test("returns a stable keyed pseudonymous identifier", () => {
    const first = buildOpenAISafetyIdentifier("123456789012345678");
    const second = buildOpenAISafetyIdentifier(" 123456789012345678 ");

    expect(first).toBe(second);
    expect(first).toBe(
      createHmac("sha256", "test-oauth-secret")
        .update("chronote:openai-safety:v1:123456789012345678")
        .digest("hex"),
    );
    expect(buildOpenAISafetyIdentifier("987654321098765432")).not.toBe(first);
    expect(first).not.toContain("123456789012345678");
  });

  test("omits an identifier when no end user is available", () => {
    expect(buildOpenAISafetyIdentifier()).toBeUndefined();
    expect(buildOpenAISafetyIdentifier("   ")).toBeUndefined();
  });
});
