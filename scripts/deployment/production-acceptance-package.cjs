"use strict";
function refuse() {
  throw Error("acceptance_package_prerequisite");
}
function assertAcceptanceJobs(jobs, source, mode, now, validity) {
  if (
    !["prepare-acceptance", "accept"].includes(mode) ||
    !Number.isSafeInteger(now) ||
    now < validity.validFrom ||
    now >= validity.validUntil ||
    jobs.total_count !== jobs.jobs.length
  )
    refuse();
  const at = (value) => {
    if (typeof value !== "string") refuse();
    const seconds = Date.parse(value) / 1000;
    if (
      !Number.isFinite(seconds) ||
      seconds < validity.validFrom ||
      seconds > now
    )
      refuse();
    return seconds;
  };
  const select = (name) => {
    const matches = jobs.jobs.filter((j) => j.name === name);
    if (matches.length !== 1 || matches[0].head_sha !== source) refuse();
    return matches[0];
  };
  const complete = (job, after, conclusion = "success") => {
    const start = at(job.started_at),
      end = at(job.completed_at);
    if (
      job.status !== "completed" ||
      job.conclusion !== conclusion ||
      start < after ||
      end < start
    )
      refuse();
    return end;
  };
  const initial = select("Introduce production"),
    continuation = select("Continue failed-unserved introduction"),
    repairGate = select("Approve failed-unserved continuation");
  let preceding;
  if (initial.conclusion === "success") {
    preceding = complete(initial, validity.validFrom);
    if (
      [continuation, repairGate].some(
        (j) => j.status !== "completed" || j.conclusion !== "skipped",
      )
    )
      refuse();
  } else {
    preceding = complete(initial, validity.validFrom, "failure");
    preceding = complete(repairGate, preceding);
    preceding = complete(continuation, preceding);
  }
  const prepare = select("Prepare production acceptance");
  if (mode === "prepare-acceptance") {
    assertPreparing(jobs, prepare, at, preceding);
    return {};
  }
  const prepareCompletedAt = complete(prepare, preceding);
  const gateCompletedAt = complete(
    select("Approve production acceptance"),
    prepareCompletedAt,
  );
  const current = select("Accept production introduction");
  if (
    current.status !== "in_progress" ||
    current.conclusion !== null ||
    current.completed_at !== null ||
    at(current.started_at) < gateCompletedAt
  )
    refuse();
  return { prepareCompletedAt, gateCompletedAt };
}
function assertPreparing(jobs, prepare, at, preceding) {
  if (
    prepare.status !== "in_progress" ||
    prepare.conclusion !== null ||
    prepare.completed_at !== null ||
    at(prepare.started_at) < preceding ||
    jobs.jobs.some(
      (j) =>
        [
          "Approve production acceptance",
          "Accept production introduction",
        ].includes(j.name) &&
        !["queued", "waiting", "pending"].includes(j.status),
    )
  )
    refuse();
}
module.exports = { assertAcceptanceJobs };
