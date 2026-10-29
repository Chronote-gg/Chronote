"use strict";
// In-flight work rules for the cold cutover. Field names and statuses match the
// legacy runtime as well as master; an unknown status always counts as in flight.

const SEGMENT_STATUSES = [
  "pending_upload",
  "uploaded",
  "submitted",
  "processing",
  "processed",
  "failed",
];

/** A claim can be renewed past the queue TTL, so only an expired request nobody claimed is settled. */
function commandActive(row, now) {
  if (["completed", "failed"].includes(row.queueStatus)) return false;
  const claimed =
    row.claimedByInstanceId !== undefined || row.claimExpiresAt !== undefined;
  return claimed || !(row.expiresAt <= now);
}

/**
 * Desktop parents carry no `expiresAt`. A live recording touches its segments every
 * minute or so, so a week without activity on the job or any segment means a paused
 * draft waiting on a client, not server work.
 */
const IDLE_DRAFT_SECONDS = 7 * 24 * 60 * 60;

/** Latest activity in seconds; a row with no parsable timestamp reads as recent. */
function lastActivity(rows) {
  const times = rows.map((row) => Date.parse(row.updatedAt ?? row.createdAt));
  if (times.some((t) => !Number.isFinite(t))) return Infinity;
  return Math.max(...times) / 1000;
}

/**
 * Only an abandoned upload intent settles: legacy finalization copies the upload-URL
 * `expiresAt` onto queued jobs, so expiry says nothing about queued or processing work.
 */
function jobActive(row, now, segments) {
  if (["complete", "failed"].includes(row.status)) return false;
  if (row.status !== "pending_upload") return true;
  if (row.expiresAt <= now) return false;
  if (row.expiresAt !== undefined) return true;
  return lastActivity([row, ...segments]) + IDLE_DRAFT_SECONDS > now;
}

/** Segments carry no TTL; a known non-terminal segment is in flight only while its job is. */
function segmentActive(row, activeJobs) {
  if (["processed", "failed"].includes(row.status)) return false;
  return !SEGMENT_STATUSES.includes(row.status) || activeJobs.has(row.uploadId);
}

/** As strict as the Sandbox bootstrap lease check: settled needs both an expired lease and a terminal status. */
function leaseActive(row, now) {
  return !(
    row.leaseExpiresAt < now && ["complete", "cancelled"].includes(row.status)
  );
}

/** Counts in-flight work; a scan failure propagates so an unknown answer never reads as empty. */
async function inFlightWork(scan, now) {
  const commands = await scan("MeetingControlCommandTable", [
    "queueStatus",
    "expiresAt",
    "claimedByInstanceId",
    "claimExpiresAt",
  ]);
  const segments = await scan("PersonalRecordingSegmentTable", [
    "uploadId",
    "status",
    "createdAt",
    "updatedAt",
  ]);
  const jobs = (
    await scan("PersonalMediaUploadJobTable", [
      "uploadId",
      "status",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ])
  ).filter((row) =>
    jobActive(
      row,
      now(),
      segments.filter((s) => s.uploadId === row.uploadId),
    ),
  );
  const activeJobs = new Set(jobs.map((row) => row.uploadId));
  // Leases are read last so the recording check sits closest to the stop.
  const leases = await scan("ActiveMeetingTable", [
    "guildId",
    "status",
    "leaseExpiresAt",
  ]);
  const counts = {
    MeetingControlCommandTable: commands.filter((r) => commandActive(r, now()))
      .length,
    PersonalMediaUploadJobTable: jobs.length,
    PersonalRecordingSegmentTable: segments.filter((r) =>
      segmentActive(r, activeJobs),
    ).length,
    ActiveMeetingTable: leases.filter((r) => leaseActive(r, now())).length,
  };
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return { counts, total };
}

module.exports = { inFlightWork };
