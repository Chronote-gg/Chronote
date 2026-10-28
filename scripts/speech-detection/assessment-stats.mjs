import { percentile } from "./evidence.mjs";
export const assessmentStats = (rows) => ({
  attempts: rows.length,
  availability: rows.length
    ? rows.filter((r) => r.assessment.kind !== "unavailable").length /
      rows.length
    : null,
  p95Ms: percentile(
    rows
      .filter((r) => r.assessment.kind !== "unavailable")
      .map((r) => r.durationMs),
  ),
  allOutcomesP95Ms: percentile(rows.map((r) => r.durationMs)),
  unavailable: rows.filter((r) => r.assessment.kind === "unavailable").length,
  queueFull: rows.filter(
    (r) =>
      r.assessment.kind === "unavailable" &&
      r.assessment.reason === "queue_full",
  ).length,
});
export const assessmentPhases = (rows) =>
  Object.fromEntries(
    ["fast", "slow"].map((p) => [
      p,
      assessmentStats(rows.filter((r) => r.phase === p)),
    ]),
  );
