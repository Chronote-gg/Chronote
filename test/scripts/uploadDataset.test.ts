import { describe, expect, test } from "@jest/globals";
import {
  MAX_ITEM_ID_LENGTH,
  resolveItemId,
  resolveItemIds,
} from "../../scripts/evals/upload-dataset";

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

  test("rejects a label too long to fit the id limit", () => {
    // Truncating would collapse two long labels sharing a prefix onto one id,
    // silently dropping a case, so the file is refused instead.
    expect(() =>
      resolveItemId(DATASET, { metadata: { label: "x".repeat(400) } }),
    ).toThrow(/too long/);
  });

  test("accepts a label that exactly fits", () => {
    const label = "x".repeat(MAX_ITEM_ID_LENGTH - `${DATASET}:`.length);

    expect(resolveItemId(DATASET, { metadata: { label } })).toHaveLength(
      MAX_ITEM_ID_LENGTH,
    );
  });
});

describe("resolveItemIds", () => {
  test("resolves every case in order", () => {
    expect(
      resolveItemIds(DATASET, [
        { metadata: { label: "a" } },
        { id: "explicit" },
        {},
      ]),
    ).toEqual(["meeting-notes:a", "explicit", undefined]);
  });

  test("rejects two cases that resolve to the same id", () => {
    expect(() =>
      resolveItemIds(DATASET, [
        { metadata: { label: "same" } },
        { metadata: { label: "same" } },
      ]),
    ).toThrow(/Duplicate dataset item id/);
  });

  test("rejects an explicit id colliding with a derived one", () => {
    expect(() =>
      resolveItemIds(DATASET, [
        { metadata: { label: "dup" } },
        { id: "meeting-notes:dup" },
      ]),
    ).toThrow(/Duplicate dataset item id/);
  });

  test("allows multiple cases with no id at all", () => {
    expect(resolveItemIds(DATASET, [{}, {}])).toEqual([undefined, undefined]);
  });
});
