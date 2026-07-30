import { describe, expect, test } from "@jest/globals";
import { resolveItemId } from "../../scripts/evals/upload-dataset";

const DATASET = "meeting-notes";

describe("resolveItemId", () => {
  test("prefers an explicit id", () => {
    expect(
      resolveItemId(DATASET, { id: "case-1", metadata: { label: "ignored" } }),
    ).toBe("case-1");
  });

  test("derives a namespaced id from metadata.label", () => {
    expect(
      resolveItemId(DATASET, { metadata: { label: "group-assign" } }),
    ).toBe("meeting-notes:group-assign");
  });

  test("returns undefined when neither is present, so the caller can warn", () => {
    expect(resolveItemId(DATASET, {})).toBeUndefined();
    expect(resolveItemId(DATASET, { metadata: {} })).toBeUndefined();
  });

  test("ignores a non-string or empty label", () => {
    expect(resolveItemId(DATASET, { metadata: { label: 7 } })).toBeUndefined();
    expect(resolveItemId(DATASET, { metadata: { label: "" } })).toBeUndefined();
  });

  test("clamps to the 255 character id limit Langfuse enforces", () => {
    const id = resolveItemId(DATASET, { metadata: { label: "x".repeat(400) } });

    expect(id).toHaveLength(255);
    expect(id?.startsWith("meeting-notes:")).toBe(true);
  });
});
