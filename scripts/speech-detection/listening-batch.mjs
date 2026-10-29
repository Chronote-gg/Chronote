import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs, isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maxClipBytes = 48000 * 4 * 180;
const maxObjectBytes = 64 * 1024 * 1024;
const require = createRequire(import.meta.url);
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

async function verified(ref, read) {
  if (
    !Number.isSafeInteger(ref.byteLength) ||
    ref.byteLength <= 0 ||
    ref.byteLength > maxObjectBytes
  )
    throw Error("object_size_invalid");
  const bytes = Buffer.from(await read(ref.key));
  if (bytes.length !== ref.byteLength || hash(bytes) !== ref.checksumSha256)
    throw Error("object_integrity_mismatch");
  return bytes;
}

export async function extractPcm(spans, artifacts, read, expected) {
  const {
    pcmSpansSchema,
  } = require("../../dist/types/transcriptCorrespondence.js");
  pcmSpansSchema.min(1).parse(spans);
  const size = spans.reduce((n, s) => n + s.endByte - s.startByte, 0);
  if (
    size > maxClipBytes + 4 * 192000 ||
    spans.some((s) => s.sourceId !== spans[0].sourceId)
  )
    throw Error("input_size_or_source_invalid");
  const pieces = [];
  for (const span of spans) {
    const matches = artifacts.filter(
      (a) =>
        a.kind === "audio" &&
        a.sourceId === span.sourceId &&
        a.sequence === span.sequence,
    );
    if (matches.length !== 1) throw Error("missing_or_ambiguous_source");
    const artifact = matches[0];
    if (
      artifact.format.encoding !== "pcm_s16le" ||
      artifact.format.sampleRate !== 48000 ||
      artifact.format.channels !== 2 ||
      span.endByte > artifact.object.byteLength
    )
      throw Error("source_format_or_bounds_invalid");
    const bytes = await verified(artifact.object, read);
    pieces.push(bytes.subarray(span.startByte, span.endByte));
  }
  const pcm = Buffer.concat(pieces);
  if (
    expected &&
    (pcm.length !== expected.audioBytes || hash(pcm) !== expected.pcmSha256)
  )
    throw Error("rejected_input_mismatch");
  return pcm;
}

export function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function selectRejections(receipts) {
  const groups = new Map();
  for (const receipt of receipts) {
    const key = JSON.stringify([
      receipt.pcmSha256,
      receipt.policyFingerprint,
      receipt.spans,
    ]);
    const existing = groups.get(key);
    if (existing) {
      existing.decisions.push({
        id: receipt.id,
        phase: receipt.phase,
        decidedAt: receipt.decidedAt,
      });
      if (receipt.outcome === "final_omission")
        existing.outcome = receipt.outcome;
    } else
      groups.set(key, {
        ...receipt,
        decisions: [
          {
            id: receipt.id,
            phase: receipt.phase,
            decidedAt: receipt.decidedAt,
          },
        ],
      });
  }
  return Array.from(groups.values()).sort(
    (a, b) =>
      Number(b.outcome === "final_omission") -
        Number(a.outcome === "final_omission") || a.audioBytes - b.audioBytes,
  );
}

export function assertManifestBinding(pointer, manifest, meetingId) {
  if (
    pointer.capture.meetingId !== meetingId ||
    !isDeepStrictEqual(manifest.capture, pointer.capture) ||
    manifest.revision !== pointer.revision ||
    manifest.artifactFolder !== pointer.artifactFolder ||
    manifest.captureState.kind !== "complete"
  )
    throw Error("manifest_identity_or_completion_mismatch");
  const prefix = `${pointer.artifactFolder}checkpoints/v1/${pointer.capture.executionVersion}-${encodeURIComponent(pointer.capture.ownerInstanceId)}/`;
  if (
    !pointer.manifest.key.startsWith(prefix) ||
    manifest.artifacts.some((a) => !a.object.key.startsWith(prefix))
  )
    throw Error("artifact_scope_mismatch");
}

const safeReason = (error, fallback) =>
  error instanceof Error && /^[a-z_]+$/.test(error.message)
    ? error.message
    : fallback;

export async function loadMeeting(input, read) {
  const {
    recordingCheckpointSchema,
    recordingManifestSchema,
  } = require("../../dist/types/recordingCheckpoint.js");
  const {
    completedTranscriptionSchema,
    generationContextSchema,
  } = require("../../dist/types/recordingContent.js");
  const pointer = recordingCheckpointSchema.parse(input.checkpoint);
  if (
    pointer.capture.meetingId !== input.meetingId ||
    !pointer.manifest.key.startsWith(pointer.artifactFolder + "checkpoints/v1/")
  )
    throw Error("checkpoint_identity_mismatch");
  const manifest = recordingManifestSchema.parse(
    JSON.parse((await verified(pointer.manifest, read)).toString("utf8")),
  );
  assertManifestBinding(pointer, manifest, input.meetingId);
  const latest = (kind) =>
    manifest.artifacts
      .filter((a) => a.kind === kind)
      .sort((a, b) => b.sequence - a.sequence)[0];
  const transcriptRef = latest("transcription"),
    contextRef = latest("context");
  if (!transcriptRef || !contextRef) throw Error("review_evidence_unavailable");
  const transcript = completedTranscriptionSchema.parse(
    JSON.parse((await verified(transcriptRef.object, read)).toString("utf8")),
  );
  const context = generationContextSchema.parse(
    JSON.parse((await verified(contextRef.object, read)).toString("utf8")),
  );
  if (
    !isDeepStrictEqual(transcript.capture, pointer.capture) ||
    !isDeepStrictEqual(context.capture, pointer.capture) ||
    context.settings.availability !== "available" ||
    context.settings.value.transcription.speechDetectionMode !== "enforce"
  )
    throw Error("capture_or_mode_mismatch");
  return { manifest, transcript };
}

export async function writeMeetingBatch({
  meetingId,
  manifest,
  transcript,
  read,
  output,
  nextNumber,
  rejectedLimit,
  controlLimit,
}) {
  const clips = [],
    gaps = [];
  if (transcript.speechRejections === undefined)
    gaps.push("legacy_checkpoint_without_rejection_receipts");
  if (transcript.speechRejectionEvidenceIncomplete)
    gaps.push("rejection_receipt_coverage_incomplete");
  const rejected = selectRejections(transcript.speechRejections ?? []).slice(
    0,
    rejectedLimit,
  );
  const rejectedInputs = new Set(rejected.map((r) => JSON.stringify(r.spans)));
  const controls = transcript.entries
    .filter(
      (e) =>
        e.source === "voice" &&
        e.correspondence?.kind === "pcm" &&
        e.correspondence.spans.length &&
        e.correspondence.spans.every((s) => s.sourceId === e.sourceId) &&
        !rejectedInputs.has(JSON.stringify(e.correspondence.spans)),
    )
    .sort(
      (a, b) =>
        spanBytes(a.correspondence.spans) - spanBytes(b.correspondence.spans),
    );
  const uniqueControls = [
    ...new Map(
      controls.map((e) => [JSON.stringify(e.correspondence.spans), e]),
    ).values(),
  ].slice(0, controlLimit);
  const candidates = [
    ...rejected.map((r) => ({
      kind: "rejected",
      spans: r.spans,
      expected: r,
      outcome: r.outcome,
      decisions: r.decisions,
      policyFingerprint: r.policyFingerprint,
    })),
    ...uniqueControls.map((e) => ({
      kind: "transcript_control",
      spans: e.correspondence.spans,
      admissionDecision: "unknown",
    })),
  ];
  for (const candidate of candidates) {
    try {
      const pcm = await extractPcm(
        candidate.spans,
        manifest.artifacts,
        read,
        candidate.expected,
      );
      const name = `${String(nextNumber()).padStart(2, "0")}-${candidate.kind}.wav`;
      await writeFile(path.join(output, name), wav(pcm), {
        flag: "wx",
        mode: 0o600,
      });
      const item = {
        file: name,
        meetingId,
        kind: candidate.kind,
        spans: candidate.spans,
        pcmSha256: hash(pcm),
        audioBytes: pcm.length,
        durationSeconds: pcm.length / 192000,
        outcome: candidate.outcome,
        decisions: candidate.decisions,
        policyFingerprint: candidate.policyFingerprint,
        admissionDecision: candidate.admissionDecision,
        context: "unavailable",
        humanReview: "pending",
      };
      clips.push(item);
      // Context is optional and only safe inside one known contiguous saved interval.
      try {
        if (candidate.spans.length === 1) {
          const span = candidate.spans[0];
          const artifact = manifest.artifacts.find(
            (a) =>
              a.kind === "audio" &&
              a.sourceId === span.sourceId &&
              a.sequence === span.sequence,
          );
          if (
            artifact.coverage.kind === "known" &&
            artifact.coverage.intervals.length === 1 &&
            !(artifact.timing?.maxCursorAdjustmentMs > 0)
          ) {
            const expanded = {
              ...span,
              startByte: Math.max(0, span.startByte - 384000),
              endByte: Math.min(
                artifact.object.byteLength,
                span.endByte + 384000,
              ),
            };
            const context = await extractPcm(
              [expanded],
              manifest.artifacts,
              read,
            );
            const contextFile = name.replace(".wav", "-context.wav");
            await writeFile(path.join(output, contextFile), wav(context), {
              flag: "wx",
              mode: 0o600,
            });
            item.context = {
              file: contextFile,
              testedStartSeconds:
                (span.startByte - expanded.startByte) / 192000,
              testedEndSeconds: (span.endByte - expanded.startByte) / 192000,
            };
          }
        }
      } catch {
        item.context = "unavailable";
      }
    } catch (error) {
      gaps.push(
        `${candidate.kind}:${safeReason(error, "source_or_output_unavailable")}`,
      );
    }
  }
  return { clips, gaps };
}
const spanBytes = (spans) =>
  spans.reduce((n, s) => n + s.endByte - s.startByte, 0);

export function assertPrivateOutput(output) {
  const relative = path.relative(root, path.resolve(output));
  const outside =
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);
  if (!outside) throw Error("output_must_be_private_and_untracked");
}

export async function resolvePrivateOutput(output) {
  const absolute = path.resolve(output);
  assertPrivateOutput(absolute);
  const resolved = path.join(
    await realpath(path.dirname(absolute)),
    path.basename(absolute),
  );
  assertPrivateOutput(resolved);
  return resolved;
}

async function operatorInputs(values) {
  if (
    !values.checkpoints ||
    !values.bucket ||
    !/^\d{12}$/.test(values.account ?? "") ||
    !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(values.region ?? "") ||
    !values.out
  )
    throw Error("explicit_operator_inputs_required");
  const { z } = require("zod");
  const selected = z
    .array(
      z
        .object({ meetingId: z.string().min(1), checkpoint: z.unknown() })
        .strict(),
    )
    .min(1)
    .max(3)
    .parse(JSON.parse(await readFile(values.checkpoints, "utf8")));
  if (new Set(selected.map((m) => m.meetingId)).size !== selected.length)
    throw Error("duplicate_meeting_selection");
  const output = await resolvePrivateOutput(values.out);
  return { selected, output };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      checkpoints: { type: "string" },
      bucket: { type: "string" },
      account: { type: "string" },
      region: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/speech-detection/listening-batch.mjs --checkpoints selected.json --bucket BUCKET --account ACCOUNT_ID --region REGION --out PRIVATE_NEW_DIRECTORY",
    );
    return;
  }
  const { selected, output } = await operatorInputs(values);
  const { STSClient, GetCallerIdentityCommand } =
    await import("@aws-sdk/client-sts");
  const identity = await new STSClient({ region: values.region }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account !== values.account) throw Error("aws_account_mismatch");
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const s3 = new S3Client({ region: values.region });
  const read = async (key) => {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: values.bucket,
        Key: key,
        ExpectedBucketOwner: values.account,
      }),
    );
    if (
      !result.Body ||
      !result.ContentLength ||
      result.ContentLength > maxObjectBytes
    )
      throw Error("source_size_invalid");
    return result.Body.transformToByteArray();
  };
  await mkdir(output, { mode: 0o700 });
  const batch = {
    status: "incomplete",
    humanReview: "pending",
    clips: [],
    gaps: [],
    targets: { rejected: 10, transcriptControls: 3 },
  };
  let number = 0;
  for (const [index, input] of selected.entries()) {
    try {
      const content = await loadMeeting(input, read);
      const result = await writeMeetingBatch({
        ...content,
        meetingId: input.meetingId,
        read,
        output,
        nextNumber: () => ++number,
        rejectedLimit: Math.ceil(
          (10 - batch.clips.filter((c) => c.kind === "rejected").length) /
            (selected.length - index),
        ),
        controlLimit: Math.ceil(
          (3 -
            batch.clips.filter((c) => c.kind === "transcript_control").length) /
            (selected.length - index),
        ),
      });
      batch.clips.push(...result.clips);
      batch.gaps.push(
        ...result.gaps.map((reason) => ({
          meetingId: input.meetingId,
          reason,
        })),
      );
    } catch (error) {
      batch.gaps.push({
        meetingId: input.meetingId,
        reason: safeReason(error, "meeting_evidence_unavailable"),
      });
    }
  }
  const rejected = batch.clips.filter((c) => c.kind === "rejected").length,
    controls = batch.clips.length - rejected;
  if (!batch.gaps.length && rejected === 10 && controls === 3)
    batch.status = "awaiting_listening";
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(batch, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      status: batch.status,
      rejected,
      transcriptControls: controls,
      gaps: batch.gaps.length,
      humanReview: "pending",
    }),
  );
  if (batch.status === "incomplete") process.exitCode = 2;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Listening batch failed. Check explicit operator inputs, access and the build. No transcript content logged.",
    );
    process.exitCode = 1;
  });
