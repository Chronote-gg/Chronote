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
 * Only an abandoned upload intent expires: legacy finalization copies the upload-URL
 * `expiresAt` onto queued jobs, so expiry says nothing about queued or processing work.
 */
function jobActive(row, now) {
  if (["complete", "failed"].includes(row.status)) return false;
  return !(row.status === "pending_upload" && row.expiresAt <= now);
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
  const jobs = (
    await scan("PersonalMediaUploadJobTable", [
      "uploadId",
      "status",
      "expiresAt",
    ])
  ).filter((row) => jobActive(row, now()));
  const activeJobs = new Set(jobs.map((row) => row.uploadId));
  const segments = await scan("PersonalRecordingSegmentTable", [
    "uploadId",
    "status",
  ]);
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
