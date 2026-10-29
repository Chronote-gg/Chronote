import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  extractPcm,
  selectRejections,
  wav,
  assertManifestBinding,
  assertPrivateOutput,
  writeMeetingBatch,
} from "./listening-batch.mjs";
const hash = (b) => createHash("sha256").update(b).digest("hex");
const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
const artifact = (sequence = 0) => ({
  kind: "audio",
  coverage: { kind: "unknown" },
  sourceId: "user:a",
  sequence,
  format: { encoding: "pcm_s16le", sampleRate: 48000, channels: 2 },
  object: {
    key: `piece${sequence}`,
    byteLength: pcm.length,
    checksumSha256: hash(pcm),
  },
});
const span = (sequence = 0, startByte = 0, endByte = 8) => ({
  sourceId: "user:a",
  sequence,
  startByte,
  endByte,
});
test("extracts ordered exact bytes across pieces and makes a playable WAV", async () => {
  const expected = Buffer.concat([pcm.subarray(4, 8), pcm.subarray(0, 8)]);
  const result = await extractPcm(
    [span(0, 4, 8), span(1)],
    [artifact(), artifact(1)],
    async () => pcm,
    { audioBytes: 12, pcmSha256: hash(expected) },
  );
  assert.deepEqual(result, expected);
  const audio = wav(result);
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(40), 12);
  assert.deepEqual(audio.subarray(44), expected);
});
test("missing, ambiguous, oversized and corrupt audio never becomes a clip", async () => {
  for (const artifacts of [[], [artifact(), artifact()]])
    await assert.rejects(extractPcm([span()], artifacts, async () => pcm));
  await assert.rejects(
    extractPcm([span()], [artifact()], async () => Buffer.alloc(12)),
  );
  await assert.rejects(
    extractPcm([span(0, 0, 16)], [artifact()], async () => pcm),
  );
  await assert.rejects(
    extractPcm([span()], [artifact()], async () => {
      throw Error("deleted");
    }),
  );
});
test("exact input hash and source binding are required", async () => {
  await assert.rejects(
    extractPcm([span()], [artifact()], async () => pcm, {
      audioBytes: 8,
      pcmSha256: "0".repeat(64),
    }),
  );
  await assert.rejects(
    extractPcm([span()], [artifact()], async () => pcm, {
      audioBytes: 4,
      pcmSha256: hash(pcm.subarray(0, 8)),
    }),
  );
  await assert.rejects(
    extractPcm(
      [span(), { ...span(1), sourceId: "user:b" }],
      [artifact(), { ...artifact(1), sourceId: "user:b" }],
      async () => pcm,
    ),
  );
});
test("duplicate fast and slow inputs group without combining overlapping inputs", () => {
  const receipt = {
    id: "first",
    spans: [span()],
    pcmSha256: "a",
    policyFingerprint: "p",
    phase: "fast",
    outcome: "request_skipped",
  };
  const result = selectRejections([
    receipt,
    { ...receipt, id: "second", phase: "slow", outcome: "final_omission" },
    { ...receipt, id: "overlap", spans: [span(0, 4, 12)] },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].decisions.length, 2);
  assert.equal(result[0].outcome, "final_omission");
});

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("meeting scope, owner attempt and completion must match before reading audio", () => {
  const capture = {
    meetingId: "one",
    executionVersion: 1,
    ownerInstanceId: "owner",
  };
  const pointer = {
    capture,
    artifactFolder: "folder/",
    revision: 1,
    manifest: { key: "folder/checkpoints/v1/1-owner/manifest" },
  };
  const manifest = {
    capture,
    artifactFolder: "folder/",
    revision: 1,
    captureState: { kind: "complete" },
    artifacts: [
      { object: { key: "folder/checkpoints/v1/1-owner/audio/piece" } },
    ],
  };
  assert.doesNotThrow(() => assertManifestBinding(pointer, manifest, "one"));
  assert.throws(() => assertManifestBinding(pointer, manifest, "another"));
  assert.throws(() =>
    assertManifestBinding(
      pointer,
      { ...manifest, captureState: { kind: "capturing" } },
      "one",
    ),
  );
  assert.throws(() =>
    assertManifestBinding(
      pointer,
      { ...manifest, capture: { ...capture, ownerInstanceId: "other" } },
      "one",
    ),
  );
  assert.throws(() =>
    assertManifestBinding(
      pointer,
      { ...manifest, artifacts: [{ object: { key: "unrelated" } }] },
      "one",
    ),
  );
});
test("batch writes real clips, groups phases, excludes transcript content, and reports legacy gaps", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "speech-batch-"));
  const receipt = {
    id: "r",
    phase: "fast",
    mode: "enforce",
    decision: "non_speech",
    spans: [span()],
    pcmSha256: hash(pcm.subarray(0, 8)),
    audioBytes: 8,
    policyFingerprint: "policy",
    outcome: "request_skipped",
  };
  const manifest = {
    artifacts: [
      {
        ...artifact(),
        coverage: {
          kind: "known",
          intervals: [{ durationMs: pcm.length / 192 }],
        },
      },
      artifact(1),
    ],
  };
  let n = 0;
  try {
    const result = await writeMeetingBatch({
      meetingId: "one",
      manifest,
      transcript: {
        speechRejections: [
          receipt,
          { ...receipt, id: "slow", phase: "slow", outcome: "final_omission" },
        ],
        entries: [
          {
            source: "voice",
            sourceId: "user:a",
            text: "PRIVATE TRANSCRIPT",
            correspondence: { kind: "pcm", spans: [span(1)] },
          },
        ],
      },
      read: async () => pcm,
      output,
      nextNumber: () => ++n,
      rejectedLimit: 10,
      controlLimit: 3,
    });
    assert.equal(result.clips.length, 2);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.clips[0].outcome, "final_omission");
    assert.deepEqual(
      (await readFile(path.join(output, result.clips[0].file))).subarray(44),
      pcm.subarray(0, 8),
    );
    assert.equal(result.clips[0].context.testedStartSeconds, 0);
    assert.equal(result.clips[1].admissionDecision, "unknown");
    assert.equal(JSON.stringify(result).includes("PRIVATE TRANSCRIPT"), false);
    assert.equal((await readdir(output)).length, 3);
    const legacy = await writeMeetingBatch({
      meetingId: "one",
      manifest,
      transcript: { entries: [] },
      read: async () => pcm,
      output,
      nextNumber: () => ++n,
      rejectedLimit: 10,
      controlLimit: 3,
    });
    assert.deepEqual(legacy.gaps, [
      "legacy_checkpoint_without_rejection_receipts",
    ]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("private output validation recognizes parent traversal by path components", () => {
  const root = path.resolve(
    new URL("../../", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ""),
  );
  assert.throws(() =>
    assertPrivateOutput(path.join(root, "..listening-private")),
  );
  assert.throws(() => assertPrivateOutput(root));
  assert.doesNotThrow(() =>
    assertPrivateOutput(path.join(root, ".cache", "listening")),
  );
  assert.doesNotThrow(() =>
    assertPrivateOutput(path.join(root, "..", "private-listening")),
  );
});

test("optional context failure preserves a valid exact clip without a coverage gap", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "speech-context-"));
  let reads = 0;
  try {
    const receipt = {
      id: "r",
      phase: "slow",
      spans: [span()],
      pcmSha256: hash(pcm.subarray(0, 8)),
      audioBytes: 8,
      policyFingerprint: "p",
      outcome: "final_omission",
    };
    const result = await writeMeetingBatch({
      meetingId: "one",
      manifest: {
        artifacts: [
          {
            ...artifact(),
            coverage: {
              kind: "known",
              intervals: [{ durationMs: pcm.length / 192 }],
            },
          },
        ],
      },
      transcript: { speechRejections: [receipt], entries: [] },
      read: async () => {
        if (++reads > 1) throw Error("context_unavailable");
        return pcm;
      },
      output,
      nextNumber: () => 1,
      rejectedLimit: 10,
      controlLimit: 0,
    });
    assert.equal(result.clips.length, 1);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.clips[0].context, "unavailable");
    assert.deepEqual(
      (await readFile(path.join(output, result.clips[0].file))).subarray(44),
      pcm.subarray(0, 8),
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
