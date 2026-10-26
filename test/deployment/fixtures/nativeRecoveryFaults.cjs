// Generated-only measurements inside the actual Node/PID1 application image.
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const {
  createRecordingCheckpointCapture,
  getCheckpointPcmBudget,
} = require("/app/dist/services/recordingCheckpointCapture");
module.exports = async function captureFaults(output, frame, publish) {
  const directory = path.join(output, "fault-capture");
  const before = getCheckpointPcmBudget().reservedBytes;
  const started = performance.now();
  let release;
  const tail = new Promise((resolve) => {
    release = resolve;
  });
  let cut;
  const cutoff = new Promise((resolve) => {
    cut = resolve;
  });
  let closureMs;
  let cutMs;
  let attempts = 0;
  const capture = createRecordingCheckpointCapture({
    directory,
    startedAt: Date.now(),
    signal: new AbortController().signal,
    commit: async () => {
      attempts++;
      closureMs ??= performance.now() - started;
      await tail;
      return false;
    },
    stopCapture: (reason) => {
      cutMs = performance.now() - started;
      cut(reason);
    },
  });
  for (let source = 0; source < 4; source++)
    capture.push(`generated-${source}`, frame);
  const reason = await cutoff;
  const held = capture.snapshot();
  const tempBytes = fs
    .readdirSync(directory)
    .reduce(
      (total, file) => total + fs.statSync(path.join(directory, file)).size,
      0,
    );
  const reservedAtCutoff = getCheckpointPcmBudget().reservedBytes - before;
  let earlyReleaseRefused = false;
  try {
    capture.releaseSettledBuffers();
  } catch {
    earlyReleaseRefused = true;
  }
  const intakeAfterCutoff = capture.push("generated-late", frame);
  release();
  await capture.settled();
  capture.releaseSettledBuffers();
  publish("faults.json", {
    reason,
    closureMs,
    cutoffMs: cutMs,
    attempts,
    held,
    tempBytes,
    reservedAtCutoff,
    reservedAfterSettlement: getCheckpointPcmBudget().reservedBytes - before,
    limitBytes: getCheckpointPcmBudget().limitBytes,
    earlyReleaseRefused,
    intakeAfterCutoff,
    sourceCount: 4,
    sourceBytes: frame.length,
    rssBytes: process.memoryUsage().rss,
    timingBasis: "native_monotonic_elapsed",
    providerAcceptance: "UNKNOWN",
  });
};
