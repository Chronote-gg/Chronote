import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_LANGFUSE_BASE_URL,
  resolveLangfuseBaseUrl,
} from "../langfuseDefaults";

describe("resolveLangfuseBaseUrl", () => {
  test("uses a configured host", () => {
    expect(resolveLangfuseBaseUrl("https://cloud.langfuse.com")).toBe(
      "https://cloud.langfuse.com",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(resolveLangfuseBaseUrl("  https://eu.example  ")).toBe(
      "https://eu.example",
    );
  });

  test.each([undefined, "", "   ", "\n\t"])(
    "falls back for a blank value: %j",
    (value) => {
      // A whitespace-only value must not reach the SDK as an endpoint, and both
      // the app and the scripts have to agree on that.
      expect(resolveLangfuseBaseUrl(value)).toBe(DEFAULT_LANGFUSE_BASE_URL);
    },
  );
});
