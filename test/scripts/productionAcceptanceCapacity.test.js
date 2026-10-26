/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { selectedAction } from "../../scripts/deployment/production-acceptance-history.cjs";
import { initialCapacityEnvelopes } from "../../scripts/deployment/production-acceptance-capacity.cjs";
import { completeManifest } from "../fixtures/productionCompleteManifest.js";
import { bound } from "../fixtures/productionManifest.js";
test("full original package budgets both exclusive paths, all permitted renewals and all final actions", () => {
  const m = completeManifest(),
    binding = bound(m);
  expect(m.actions).toHaveLength(200);
  expect(
    ["normal", "replacement"].map(
      (path) => m.actions.filter((a) => selectedAction(a, path, m)).length,
    ),
  ).toEqual([95, 107]);
  const result = initialCapacityEnvelopes(binding, { records: [] });
  expect(result).toHaveLength(6);
  expect(result.map((r) => r.targets)).toEqual([14, 14, 14, 15, 15, 15]);
  for (const r of result)
    expect(r.maximumItemBytes).toBeLessThan(4 * 1024 * 1024);
});
test("current projected history consumes its full unknown item ceiling before any stop", () => {
  const binding = bound(completeManifest());
  const records = [0, 1].map((index) => ({
    table: "meetingHistory",
    key: { guildId: "other", channelId_timestamp: String(index) },
    metadata: { status: "complete" },
  }));
  expect(() => initialCapacityEnvelopes(binding, { records })).toThrow(
    "acceptance_capacity_refused",
  );
});
test("an already retained fixed fixture command is deduplicated by actual table and key", () => {
  const binding = bound(completeManifest()),
    requestId = binding.manifest.handoff.grants[0].commandId;
  expect(
    initialCapacityEnvelopes(binding, {
      records: [
        {
          table: "meetingControl",
          key: { requestId },
          metadata: { queueStatus: "complete" },
        },
      ],
    }),
  ).toEqual(initialCapacityEnvelopes(binding, { records: [] }));
});

test("continuation deduplicates the actual consumed fixture history key without dropping its ceiling", () => {
  const binding = bound(completeManifest());
  const key = {
    guildId: binding.manifest.handoff.grants[0].guildId,
    channelId_timestamp: "known-fixture",
  };
  expect(
    initialCapacityEnvelopes(
      binding,
      { records: [{ table: "meetingHistory", key, metadata: {} }] },
      [key],
    ),
  ).toEqual(initialCapacityEnvelopes(binding, { records: [] }));
});
