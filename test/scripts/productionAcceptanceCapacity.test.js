/** @jest-environment node */
import { test, expect } from "@jest/globals";
import { selectedAction } from "../../scripts/deployment/production-acceptance-history.cjs";
import {
  initialCapacityEnvelopes,
  runtimeCapacityEnvelope,
  fixtureCoordinatorCapacityEnvelope,
  assertSupportedRuntimeSize,
  assertSupportedFixtureAuthoritySize,
  initializationCapacityEnvelope,
} from "../../scripts/deployment/production-acceptance-capacity.cjs";
import { writerFixture } from "../fixtures/productionAcceptanceWriters.js";
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
test("projected history retains its full unknown item ceiling before any stop", () => {
  const binding = bound(completeManifest());
  const records = [0, 1].map((index) => ({
    table: "meetingHistory",
    key: { guildId: "other", channelId_timestamp: String(index) },
    metadata: { status: "complete" },
  }));
  const empty = initialCapacityEnvelopes(binding, { records: [] });
  const actual = initialCapacityEnvelopes(binding, { records });
  expect(
    actual.map((row, i) => row.maximumItemBytes - empty[i].maximumItemBytes),
  ).toEqual(Array(6).fill(2 * 400 * 1024));
});

test("complete typed runtime and fixture authority bounds leave capacity for four projected personal rows", () => {
  const binding = bound(completeManifest());
  const records = [0, 1, 2, 3].map((n) => ({
    table: n < 2 ? "personalJob" : "personalSegment",
    key:
      n < 2
        ? { uploadId: String(n) }
        : { uploadId: String(n - 2), segmentKey: "mic#0" },
    metadata: {},
  }));
  expect(initialCapacityEnvelopes(binding, { records })).toHaveLength(6);
  expect(() =>
    initialCapacityEnvelopes(binding, {
      records: [
        ...records,
        {
          table: "personalSegment",
          key: { uploadId: "0", segmentKey: "mic#1" },
          metadata: {},
        },
      ],
    }),
  ).toThrow("acceptance_capacity_refused");
  for (const slot of ["bootstrap", "replacement", "handoff"])
    expect(
      runtimeCapacityEnvelope(
        binding,
        slot,
        slot === "handoff" ? "serving" : "retired",
      ).maximumItemBytes,
    ).toBeLessThan(400 * 1024);
  for (const path of ["normal", "replacement"])
    expect(
      fixtureCoordinatorCapacityEnvelope(binding, path).maximumItemBytes,
    ).toBeLessThan(400 * 1024);
});

test("complete observed rows fit the exact original-slot envelopes", () => {
  const f = writerFixture(),
    binding = bound(f.m);
  for (const row of f.runtimes)
    expect(() => assertSupportedRuntimeSize(binding, row)).not.toThrow();
  expect(() =>
    assertSupportedFixtureAuthoritySize(binding, f.fixtureAuthority),
  ).not.toThrow();
});

test("supported optional capability remains inside the complete runtime bound", () => {
  const f = writerFixture(),
    binding = bound(f.m),
    row = f.runtimes[0];
  row.canonicalContentWriter = 1;
  expect(() => assertSupportedRuntimeSize(binding, row)).not.toThrow();
});

test.each(["wrong predecessor", "extra field", "multibyte task"])(
  "fixture authority capacity refuses %s",
  (problem) => {
    const f = writerFixture(),
      binding = bound(f.m),
      row = f.fixtureAuthority;
    if (problem === "wrong predecessor") row.priorMember.candidateId = "other";
    if (problem === "extra field") row.extra = true;
    if (problem === "multibyte task") row.priorMember.taskArn = "é".repeat(513);
    expect(() => assertSupportedFixtureAuthoritySize(binding, row)).toThrow();
  },
);

test("source-derived strings that exceed a complete item refuse before interruption", () => {
  const binding = bound(completeManifest());
  binding.manifest.runtime.candidateId = "x".repeat(400 * 1024);
  expect(() => initialCapacityEnvelopes(binding, { records: [] })).toThrow();
});

function cohortFixture() {
  const identities = ["one", "two"].map((uploadId) => ({
    uploadId,
    ownerUserId: "owner",
    sourceCount: 1,
  }));
  return {
    identities,
    parents: identities.map(({ uploadId, ownerUserId }) => ({
      uploadId,
      ownerUserId,
    })),
    segments: identities.map(({ uploadId }) => ({
      uploadId,
      segmentKey: "mic#0",
    })),
    declaration: { capture: { sha256: "a".repeat(64) } },
    digests: {
      cohortSha256: "b".repeat(64),
      captureSha256: "a".repeat(64),
      policyScopeSha256: "c".repeat(64),
    },
  };
}
test("initialization budgets exact physical targets in builder order without reducing projected rows", () => {
  const binding = bound(completeManifest()),
    cohort = cohortFixture();
  const lineage = binding.manifest.actions.filter((a) =>
    ["stop_service", "route_maintenance"].includes(a.kind),
  );
  const bounds = initializationCapacityEnvelope(binding, cohort, lineage);
  expect(bounds).toHaveLength(12);
  expect(bounds.map((b) => b.key)).toEqual([
    { pk: "ENV", sk: "INTRODUCTION" },
    {
      pk: `INTRODUCTION#${binding.manifest.introductionId}`,
      sk: `OPERATION#${binding.manifest.operationId}`,
    },
    ...lineage.map((a) => ({
      pk: `INTRODUCTION#${binding.manifest.introductionId}`,
      sk: `ACTION#${a.actionId}`,
    })),
    { pk: "ENV", sk: "CONTROL" },
    {
      pk: `INTRODUCTION#${binding.manifest.introductionId}`,
      sk: "INITIALIZATION",
    },
    ...cohort.parents.map((r) => ({ uploadId: r.uploadId })),
    ...cohort.segments.map((r) => ({
      uploadId: r.uploadId,
      segmentKey: r.segmentKey,
    })),
    ...cohort.identities.map((r) => ({
      pk: `UPLOAD#${r.uploadId}`,
      sk: "PAUSED_DRAFT",
    })),
  ]);
  for (const index of [0, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(bounds[index].maximumItemBytes).toBe(400 * 1024);
  expect(() =>
    initializationCapacityEnvelope(
      binding,
      {
        ...cohort,
        segments: [
          ...cohort.segments,
          { uploadId: "one", segmentKey: "mic#1" },
          { uploadId: "one", segmentKey: "mic#2" },
        ],
      },
      lineage,
    ),
  ).toThrow("acceptance_capacity_refused");
  const withoutMarkers = initialCapacityEnvelopes(binding, { records: [] });
  const withMarkers = initialCapacityEnvelopes(
    binding,
    { records: [] },
    [],
    cohort,
  );
  expect(withMarkers.map((r) => r.targets)).toEqual(
    withoutMarkers.map((r) => r.targets + 2),
  );
});

test.each([
  "non UUID",
  "overlong task",
  "unsafe number",
  "unknown field",
  "wrong slot",
  "TTL",
])("runtime capacity refuses %s", (problem) => {
  const f = writerFixture(),
    binding = bound(f.m),
    row = f.runtimes[0];
  const changes = {
    "non UUID": () => {
      row.identity.instanceId = "worker";
      row.sk = "RUNTIME#worker";
    },
    "overlong task": () => {
      row.identity.taskArn = "x".repeat(1025);
    },
    "unsafe number": () => {
      row.heartbeatAt = Number.MAX_SAFE_INTEGER + 1;
    },
    "unknown field": () => {
      row.extra = true;
    },
    "wrong slot": () => {
      row.identity.candidateId = "other";
    },
    TTL: () => {
      row.expiresAt = 400;
    },
  };
  changes[problem]();
  expect(() => assertSupportedRuntimeSize(binding, row)).toThrow();
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
