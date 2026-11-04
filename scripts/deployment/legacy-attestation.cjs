"use strict";
const { createHash } = require("node:crypto");
const { z } = require("zod");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { CoordinatorFailure } = require("./coordinator-aws.cjs");
const HEAD_CONCURRENCY = 16;
const safePath = (path) =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((part) => part && part !== "." && part !== "..");
const manifestSchema = z
  .object({
    source: z.string().min(1),
    capturedAt: z.string().datetime(),
    layout: z.literal("files/<path>"),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1024).refine(safePath),
            bytes: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(20_000)
      .refine(
        (files) => new Set(files.map((f) => f.path)).size === files.length,
      ),
  })
  .strict();
function refuse(message) {
  throw new CoordinatorFailure("artifact_preservation_unconfirmed", message);
}
const capturedAt = (document) =>
  Math.floor(Date.parse(document.capturedAt) / 1000);
function defaultS3() {
  const s3 = require("@aws-sdk/client-s3");
  const client = new s3.S3Client({});
  return (name, input) => client.send(new s3[name + "Command"](input));
}
/**
 * Operator evidence that a legacy source's local meeting artifacts were
 * backed up, plus the staleness guard that keeps that evidence current.
 * A legacy runtime predates the artifact protocol, so it is recognised by
 * having no artifact row at all: a protocol runtime creates its row on its
 * first heartbeat and can only become serving with a sealed startup proof in
 * that row.
 */
function createLegacyAttestation(deps) {
  const { aws, tables, now, types, legacy, runtime, control, lookup } = deps;
  const s3 = deps.s3 ?? defaultS3();
  const env = deps.env ?? process.env;
  function settings() {
    const value = (key) =>
      env[key]?.trim() ||
      refuse(`Missing ${key} for legacy preservation attestation`);
    return {
      manifestUri: value("ATTESTATION_MANIFEST_URI"),
      operator: value("ATTESTATION_OPERATOR"),
      reason: value("ATTESTATION_REASON"),
    };
  }
  async function manifest(uri) {
    const match = /^s3:\/\/([^/]+)\/(.+\/)?([^/]+)$/.exec(uri);
    if (!match) refuse("Attestation manifest must be an s3:// object URI");
    const [, bucket, prefix = "", name] = match;
    let body;
    let parsed;
    try {
      const response = await s3("GetObject", {
        Bucket: bucket,
        Key: prefix + name,
      });
      body = Buffer.from(await response.Body.transformToByteArray());
      parsed = manifestSchema.safeParse(JSON.parse(body.toString("utf8")));
    } catch {
      refuse("Attestation manifest is unreadable");
    }
    if (!parsed.success) refuse("Attestation manifest is malformed");
    return {
      bucket,
      key: prefix + name,
      prefix,
      document: parsed.data,
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }
  async function verifyObject(bucket, key, file) {
    let head;
    try {
      head = await s3("HeadObject", {
        Bucket: bucket,
        Key: key,
        ChecksumMode: "ENABLED",
      });
    } catch {
      refuse("An attested backup object is missing or unreadable");
    }
    if (
      head.ContentLength !== file.bytes ||
      head.ChecksumSHA256 !== Buffer.from(file.sha256, "hex").toString("base64")
    )
      refuse("An attested backup object differs from its manifest entry");
  }
  async function verifyObjects({ bucket, prefix, document }) {
    let next = 0;
    const worker = async () => {
      while (next < document.files.length) {
        const file = document.files[next++];
        await verifyObject(bucket, prefix + "files/" + file.path, file);
      }
    };
    await Promise.all(Array.from({ length: HEAD_CONCURRENCY }, worker));
  }
  async function scan(TableName, filter) {
    const rows = [];
    let start;
    do {
      const page = await aws("dynamodb", "scan", {
        TableName,
        ...filter,
        ExpressionAttributeValues: marshall(filter.ExpressionAttributeValues),
        ConsistentRead: true,
        ...(start ? { ExclusiveStartKey: start } : {}),
      });
      rows.push(...(page.Items ?? []).map((item) => unmarshall(item)));
      start = page.LastEvaluatedKey;
    } while (start);
    return rows;
  }
  /** Leases the source took at or after the copy; seconds are floored, so ties count. */
  async function newerLeases(identity, capturedAt) {
    const leases = await scan(tables.activeMeeting, {
      FilterExpression: "ownerInstanceId = :owner",
      ProjectionExpression: "createdAt",
      ExpressionAttributeValues: { ":owner": identity.instanceId },
    });
    return leases.filter(
      (lease) => !(Date.parse(lease.createdAt) < capturedAt * 1000),
    ).length;
  }
  /**
   * A cleanly released lease is deleted, so history is the durable record of
   * meetings the source ran around the copy.
   */
  async function uncoveredMeetings(identity, capturedAt) {
    const meetings = await scan(tables.meetingHistory, {
      FilterExpression: "ownerInstanceId = :owner AND #timestamp >= :since",
      ProjectionExpression: "#timestamp, #status, audioS3Key",
      ExpressionAttributeNames: {
        "#timestamp": "timestamp",
        "#status": "status",
      },
      ExpressionAttributeValues: {
        ":owner": identity.instanceId,
        ":since": legacy.legacyMeetingWindowStart(capturedAt),
      },
    });
    return legacy.uncoveredLegacyMeetings(meetings, capturedAt).length;
  }
  function assertQuiet(row, pendingAdmission) {
    const counts = row.workCounts;
    if (
      row.role !== "serving" ||
      row.heartbeatAt <= now() - types.ARTIFACT_PROOF_SECONDS ||
      counts?.recording !== 0 ||
      !Number.isSafeInteger(counts.pending_admission) ||
      (pendingAdmission !== undefined &&
        counts.pending_admission !== pendingAdmission)
    )
      refuse(
        "Legacy source is recording, admitting new work or not heartbeating",
      );
  }
  /**
   * Refuses unless the source is still serving, records nothing, holds the
   * attested pending admission count (once attested) and ran no meeting the
   * copy could miss.
   */
  async function guard(identity, capturedAt, pendingAdmission) {
    const row = await runtime(identity);
    assertQuiet(row, pendingAdmission);
    if (await newerLeases(identity, capturedAt))
      refuse("A meeting started on the legacy source after its backup");
    if (await uncoveredMeetings(identity, capturedAt))
      refuse(
        "A meeting around the backup is not settled with its audio stored",
      );
    return row;
  }
  /** The seal-time recheck: the guard again, and the manifest still unchanged. */
  async function recheck(row) {
    const { attestation } = row;
    await guard(
      row.identity,
      attestation.capturedAt,
      attestation.pendingAdmission,
    );
    if (
      (await manifest(attestation.manifestUri)).sha256 !==
      attestation.manifestSha256
    )
      refuse("Attestation manifest changed after attestation");
  }
  function target(ctl) {
    if (ctl.deployment?.phase === "preparing") return ctl.deployment.outgoing;
    const members = Object.values(ctl.servingMembers);
    if (members.length !== 1)
      refuse("Attestation requires exactly one serving runtime");
    return members[0];
  }
  async function attestable(ctl) {
    const identity = target(ctl);
    const existing = await lookup(identity);
    if (existing && !existing.attestation)
      refuse("Source has an artifact row; it must use the runtime protocol");
    if (existing && existing.state !== "attested_legacy")
      refuse(
        "Attested preparation is in progress; run cancel-preparation first",
      );
    return { identity, existing };
  }
  function record(identity, existing, evidence, input, source, time) {
    const { document } = evidence;
    return {
      ...types.artifactSafetyKey(identity),
      recordType: "artifact_safety",
      schemaVersion: 1,
      identity,
      revision: existing ? existing.revision + 1 : 0,
      heartbeatAt: time,
      freshUntil: time + types.ARTIFACT_PROOF_SECONDS,
      startup: { kind: "pending" },
      state: "attested_legacy",
      attestation: {
        kind: "operator_attested_legacy",
        operator: input.operator,
        reason: input.reason,
        manifestUri: input.manifestUri,
        manifestSha256: evidence.sha256,
        taskId: legacy.legacyTaskId(source),
        pendingAdmission: source.workCounts.pending_admission,
        capturedAt: capturedAt(document),
        fileCount: document.files.length,
        byteLength: document.files.reduce((sum, file) => sum + file.bytes, 0),
        verifiedAt: time,
        expiresAt: time + types.LEGACY_ATTESTATION_SECONDS,
      },
    };
  }
  async function bound(input) {
    const { identity } = await attestable(await control());
    const evidence = await manifest(input.manifestUri);
    if (
      !legacy.legacyManifestBound(
        evidence.key,
        evidence.document.source,
        await runtime(identity),
      )
    )
      refuse(
        "Attestation manifest is not bound to the source task or instance",
      );
    if (capturedAt(evidence.document) > now())
      refuse("Attestation manifest was captured in the future");
    return evidence;
  }
  async function attest() {
    await deps.assertWriter();
    const input = settings();
    const evidence = await bound(input);
    await verifyObjects(evidence);
    const ctl = await control();
    const { identity, existing } = await attestable(ctl);
    const source = await guard(identity, capturedAt(evidence.document));
    const time = now();
    const next = types.artifactSafetyRecordSchema.parse(
      record(identity, existing, evidence, input, source, time),
    );
    await aws(
      "dynamodb",
      "transact-write-items",
      legacy.buildLegacyArtifactTransaction(
        {
          purpose: "attest",
          expected: existing,
          next,
          runtime: source,
          control: ctl,
          now: time,
        },
        tables,
      ),
    );
    const { attestation } = next;
    return {
      kind: "attested",
      instanceId: identity.instanceId,
      manifestSha256: attestation.manifestSha256,
      fileCount: attestation.fileCount,
      byteLength: attestation.byteLength,
      expiresAt: attestation.expiresAt,
    };
  }
  return { attest, recheck };
}
module.exports = { createLegacyAttestation };
