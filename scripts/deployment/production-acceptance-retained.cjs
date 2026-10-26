"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { canonicalHash } = require("./production-manifest.cjs");
const {
  readRetainedMetadata,
  classifyRetainedWork,
  projections,
} = require("./retained-work.cjs");
const {
  preservedUnadmittedReceipt,
  receiptBoundary,
  receiptProjectionVersion,
} = require("./retained-receipts.cjs");
function refuse() {
  throw Error("acceptance_retained_prerequisite");
}
async function collectRetainedClosure(
  f,
  loaded,
  readers,
  writers,
  compatibility,
  now,
) {
  const m = f.binding.manifest;
  const snapshot = await readRetainedMetadata({
    tables: m.resources.tables,
    read: readers.scan,
    now,
  });
  if (
    snapshot.coverage.length !== Object.keys(projections).length ||
    snapshot.coverage.some((c) => c.status !== "enumerated")
  )
    refuse();
  const closure = {
    predicate: receiptBoundary,
    projection: receiptProjectionVersion,
    ...compatibility,
    hold: { holdId: m.holdId, introductionId: m.introductionId, revision: 1 },
    writers: writers.map(({ identity, sourceCommit }) => ({
      identity,
      sourceCommit,
    })),
  };
  const compatible = snapshot.records.filter(
    (r) =>
      r.table === "stripeWebhook" &&
      preservedUnadmittedReceipt(r.metadata, closure) ===
        "preserved_unadmitted_receipt",
  );
  const remaining = {
    ...snapshot,
    records: snapshot.records.filter((r) => !compatible.includes(r)),
  };
  const classification = classifyRetainedWork(
    remaining,
    loaded.evidence.retainedDisposition,
    compatibility,
  );
  if (classification.reopeningBlockers.length) refuse();
  return { snapshot, closure, classification, compatible };
}
function at(row, path) {
  return path.split(".").reduce((value, part) => value?.[part], row);
}
function assertOverlap(prior, guard, path) {
  const a = at(prior.row, path),
    b = at(guard.row, path);
  if (
    prior.presentFields?.includes(path) ||
    guard.presentFields?.includes(path)
  ) {
    if (a === undefined || b === undefined) refuse();
  } else if (!same(a, b)) refuse();
}
function assertCompatibleGuards(prior, guard) {
  for (const left of prior.fields)
    for (const right of guard.fields) {
      if (
        left === right ||
        left.startsWith(right + ".") ||
        right.startsWith(left + ".")
      )
        assertOverlap(prior, guard, left.length > right.length ? left : right);
    }
}
function combinedProjection(prior, guard) {
  const all = [...new Set([...prior.fields, ...guard.fields])];
  const fields = all.filter(
    (field) =>
      !all.some((parent) => parent !== field && field.startsWith(parent + ".")),
  );
  const row = {},
    presentFields = [];
  for (const field of fields) {
    const source = guard.fields.includes(field) ? guard : prior;
    const value = at(source.row, field);
    if (source.presentFields?.includes(field)) presentFields.push(field);
    if (value === undefined) continue;
    const parts = field.split(".");
    let target = row;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = structuredClone(value);
  }
  return { row, fields, presentFields };
}
function mergeGuards(guards) {
  const merged = new Map();
  for (const guard of guards) {
    const key = canonicalHash({ table: guard.table, key: guard.key }),
      prior = merged.get(key);
    if (!prior) {
      merged.set(key, structuredClone(guard));
      continue;
    }
    assertCompatibleGuards(prior, guard);
    Object.assign(prior, combinedProjection(prior, guard), {
      maximumItemBytes: Math.max(
        prior.maximumItemBytes,
        guard.maximumItemBytes,
      ),
    });
  }
  return [...merged.values()];
}
module.exports = { collectRetainedClosure, mergeGuards };
