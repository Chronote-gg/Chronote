/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { inFlightWork } from "../../scripts/deployment/cold-cutover-work.cjs";

const NOW = 1000;
const PAST = NOW - 1;
const FUTURE = NOW + 600;

async function count(tables) {
  const scan = async (name) => tables[name] ?? [];
  return inFlightWork(scan, () => NOW);
}

test.each([
  ["a live lease", { status: "in_progress", leaseExpiresAt: FUTURE }, 1],
  [
    "a terminal lease still leased",
    { status: "complete", leaseExpiresAt: FUTURE },
    1,
  ],
  [
    "an expired lease without a terminal status",
    { status: "in_progress", leaseExpiresAt: PAST },
    1,
  ],
  ["a lease with no fields", { guildId: "g" }, 1],
  [
    "an expired complete lease awaiting TTL",
    { status: "complete", leaseExpiresAt: PAST },
    0,
  ],
  [
    "an expired cancelled lease awaiting TTL",
    { status: "cancelled", leaseExpiresAt: PAST },
    0,
  ],
])("%s counts %i", async (_, row, expected) => {
  const work = await count({ ActiveMeetingTable: [row] });
  expect(work.counts.ActiveMeetingTable).toBe(expected);
});

test.each([
  [
    "an abandoned upload intent past its TTL",
    { status: "pending_upload", expiresAt: PAST },
    0,
  ],
  [
    "an upload intent still open",
    { status: "pending_upload", expiresAt: FUTURE },
    1,
  ],
  ["an upload intent without a TTL", { status: "pending_upload" }, 1],
  [
    "a queued job carrying a stale upload expiry",
    { status: "queued", expiresAt: PAST },
    1,
  ],
  [
    "a processing job carrying a stale upload expiry",
    { status: "processing", expiresAt: PAST },
    1,
  ],
  ["an unknown job status", { status: "renamed", expiresAt: PAST }, 1],
  ["a complete job", { status: "complete" }, 0],
])("%s counts %i", async (_, row, expected) => {
  const work = await count({ PersonalMediaUploadJobTable: [row] });
  expect(work.counts.PersonalMediaUploadJobTable).toBe(expected);
});

test.each([
  ["a segment of an active job", "queued", { status: "uploaded" }, 1],
  [
    "a segment of an abandoned intent",
    "pending_upload",
    { status: "uploaded" },
    0,
  ],
  ["a segment whose job is gone", undefined, { status: "submitted" }, 0],
  ["an unknown segment status", undefined, { status: "renamed" }, 1],
  [
    "a processed segment of an active job",
    "processing",
    { status: "processed" },
    0,
  ],
])("%s counts %i", async (_, jobStatus, segment, expected) => {
  const jobs = jobStatus
    ? [{ uploadId: "u1", status: jobStatus, expiresAt: PAST }]
    : [];
  const work = await count({
    PersonalMediaUploadJobTable: jobs,
    PersonalRecordingSegmentTable: [{ uploadId: "u1", ...segment }],
  });
  expect(work.counts.PersonalRecordingSegmentTable).toBe(expected);
});

const WEEK = 7 * 24 * 60 * 60;
const iso = (seconds) => new Date(seconds * 1000).toISOString();
const IDLE = iso(NOW - WEEK - 1);
const RECENT = iso(NOW - 60);

test.each([
  [
    "a desktop draft idle for over a week",
    { createdAt: IDLE, updatedAt: IDLE },
    [{ status: "uploaded", updatedAt: IDLE }],
    0,
  ],
  [
    "a desktop recording whose latest segment is recent",
    { createdAt: IDLE, updatedAt: IDLE },
    [{ status: "uploaded", updatedAt: RECENT }],
    1,
  ],
  [
    "a desktop recording started recently",
    { createdAt: RECENT, updatedAt: RECENT },
    [],
    1,
  ],
  [
    "a draft without timestamps",
    {},
    [{ status: "uploaded", updatedAt: IDLE }],
    1,
  ],
  [
    "a draft whose segment has no timestamp",
    { createdAt: IDLE, updatedAt: IDLE },
    [{ status: "uploaded" }],
    1,
  ],
])("%s counts %i", async (_, job, segments, expected) => {
  const work = await count({
    PersonalMediaUploadJobTable: [
      { uploadId: "d1", status: "pending_upload", ...job },
    ],
    PersonalRecordingSegmentTable: segments.map((s) => ({
      uploadId: "d1",
      ...s,
    })),
  });
  expect(work.counts.PersonalMediaUploadJobTable).toBe(expected);
  expect(work.counts.PersonalRecordingSegmentTable).toBe(
    expected ? segments.length : 0,
  );
});

test("idleness never settles a queued job", async () => {
  const work = await count({
    PersonalMediaUploadJobTable: [
      { uploadId: "q1", status: "queued", createdAt: IDLE, updatedAt: IDLE },
    ],
  });
  expect(work.counts.PersonalMediaUploadJobTable).toBe(1);
});

test("a scan failure propagates instead of reading as empty", async () => {
  const scan = async (name) => {
    if (name === "ActiveMeetingTable") throw new Error("denied");
    return [];
  };
  await expect(inFlightWork(scan, () => NOW)).rejects.toThrow("denied");
});

test("the total sums every table", async () => {
  const work = await count({
    MeetingControlCommandTable: [{ queueStatus: "pending", expiresAt: FUTURE }],
    ActiveMeetingTable: [{ status: "in_progress", leaseExpiresAt: FUTURE }],
  });
  expect(work.total).toBe(2);
});
