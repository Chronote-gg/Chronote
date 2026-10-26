/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { mergeGuards } from "../../scripts/deployment/production-acceptance-retained.cjs";
const guard = (row, fields) => ({
  table: "history",
  key: { guildId: "guild", channelId_timestamp: "meeting" },
  row,
  fields,
  maximumItemBytes: 409600,
});
test.each([false, true])(
  "overlapping full and projected snapshots refuse changed nested facts, reverse=%s",
  (reverse) => {
    const guards = [
      guard({ checkpoint: { revision: 1 } }, ["checkpoint.revision"]),
      guard({ checkpoint: { revision: 2, manifest: { key: "output" } } }, [
        "checkpoint",
      ]),
    ];
    expect(() => mergeGuards(reverse ? guards.reverse() : guards)).toThrow();
  },
);
test.each([false, true])(
  "matching parent fields preserve the full guarded object, reverse=%s",
  (reverse) => {
    const guards = [
      guard({ checkpoint: { revision: 1 } }, ["checkpoint.revision"]),
      guard({ checkpoint: { revision: 1, manifest: { key: "output" } } }, [
        "checkpoint",
      ]),
    ];
    expect(mergeGuards(reverse ? guards.reverse() : guards)[0]).toMatchObject({
      row: { checkpoint: { revision: 1, manifest: { key: "output" } } },
      fields: ["checkpoint"],
    });
  },
);
