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
  pausedContext,
) {
  const m = f.binding.manifest;
  const drafts = require("./production-paused-drafts.cjs");
  const acquired = pausedContext
    ? await drafts.collectPausedDraftMetadata(
        pausedContext.bound,
        readers,
        "final",
        pausedContext.settingsToken,
      )
    : undefined;
  const snapshot = await readRetainedMetadata({
    tables: m.resources.tables,
    read: readers.scan,
    now: pausedContext ? Math.floor(Date.now() / 1000) : now,
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
  const paused = pausedContext
    ? await drafts.collectPreservedPausedCohort(
        acquired,
        readers,
        pausedContext.installation,
        snapshot,
        pausedContext.settingsToken,
      )
    : undefined;
  const classification = classifyRetainedWork(
    remaining,
    loaded.evidence.retainedDisposition,
    compatibility,
    paused,
  );
  if (classification.reopeningBlockers.length) refuse();
  return {
    snapshot,
    closure,
    classification,
    compatible,
    ...(paused ? { paused } : {}),
  };
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
  const row = {
      ...(guard.pausedParent
        ? { sourceManifest: structuredClone(guard.row.sourceManifest) }
        : prior.pausedParent
          ? { sourceManifest: structuredClone(prior.row.sourceManifest) }
          : {}),
    },
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
      ...(prior.pausedParent || guard.pausedParent
        ? { pausedParent: true }
        : {}),
      maximumItemBytes: Math.max(
        prior.maximumItemBytes,
        guard.maximumItemBytes,
      ),
    });
  }
  return [...merged.values()];
}
module.exports = { collectRetainedClosure, mergeGuards };
