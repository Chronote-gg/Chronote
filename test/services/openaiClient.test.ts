import { buildOpenAISafetyIdentifier } from "../../src/services/openaiClient";

describe("buildOpenAISafetyIdentifier", () => {
  test("returns a stable privacy-preserving identifier", () => {
    const first = buildOpenAISafetyIdentifier("123456789012345678");
    const second = buildOpenAISafetyIdentifier(" 123456789012345678 ");

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("123456789012345678");
  });

  test("omits an identifier when no end user is available", () => {
    expect(buildOpenAISafetyIdentifier()).toBeUndefined();
    expect(buildOpenAISafetyIdentifier("   ")).toBeUndefined();
  });
});
