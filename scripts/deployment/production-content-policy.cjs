"use strict";
const { isDeepStrictEqual } = require("node:util");
const LIMIT = 2048;
const longestOwner = "00000000-0000-4000-8000-000000000000";
function artifactClasses(ownerInstanceId) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      ownerInstanceId,
    )
  )
    refuse();
  const attempt = `checkpoints/v1/1-${encodeURIComponent(ownerInstanceId)}/`;
  return [
    "transcript.json",
    ...["manifests", "audio"].map((kind) => `${attempt}${kind}/*`),
  ];
}
function refuse() {
  throw Error("fixture_content_scope_refused");
}
function component(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) refuse();
  return value;
}
function prefix(m) {
  if (m.resources.artifactPrefixes.length !== 1) refuse();
  const value = m.resources.artifactPrefixes[0];
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)+$/.test(value)) refuse();
  return value;
}
function fixtureFolder(m, index, reservedAt) {
  if (![0, 1].includes(index)) refuse();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(reservedAt))
    refuse();
  const time = Date.parse(reservedAt);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== reservedAt ||
    time < m.validFrom * 1000 ||
    time >= m.validUntil * 1000
  )
    refuse();
  const g = m.handoff.grants[index];
  return `${prefix(m)}${component(g.guildId)}/${component(g.voiceChannelId)}_${component(g.meetingId)}_${reservedAt.replace(/:/g, "-")}/`;
}
function storageKey(m) {
  const expected = `arn:aws:kms:${m.identity.region}:${m.identity.accountId}:key/`;
  const key = m.acceptance.storageKeyArn;
  if (
    !key?.startsWith(expected) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      key.slice(expected.length),
    )
  )
    refuse();
  return key;
}
function contentPolicy(m, index, reservedAt, ownerInstanceId) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(m.resources.bucket)) refuse();
  const folder = fixtureFolder(m, index, reservedAt);
  const resources = artifactClasses(ownerInstanceId).map(
    (suffix) => `arn:aws:s3:::${m.resources.bucket}/${folder}${suffix}`,
  );
  // The base policy independently retains ViaService and CallerAccount on every KMS allow.
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: resources,
      },
      {
        Effect: "Allow",
        Action: ["kms:Decrypt"],
        Resource: storageKey(m),
        Condition: {
          StringLike: { "kms:EncryptionContext:aws:s3:arn": resources },
        },
      },
    ],
  };
  if (JSON.stringify(policy).length > LIMIT) refuse();
  return policy;
}
function contentPreflight(m) {
  const contentSessionCutoff = m.validUntil - 900;
  if (
    m.acceptance.prepareDeadline > contentSessionCutoff ||
    m.acceptance.prepareDeadline <= m.validFrom
  )
    refuse();
  // ISO timestamps have fixed length. Every other character is already fixed by the original package.
  const reservedAt = new Date(m.validFrom * 1000).toISOString();
  return {
    contentSessionCutoff,
    policyCharacters: [0, 1].map(
      (index) =>
        JSON.stringify(contentPolicy(m, index, reservedAt, longestOwner))
          .length,
    ),
  };
}
function sessionName(m, index) {
  if (![0, 1].includes(index)) refuse();
  const value = `introduction-content-${m.identity.runId}-${m.identity.runAttempt}-${index}`;
  if (!/^introduction-content-\d+-1-[01]$/.test(value) || value.length > 64)
    refuse();
  return value;
}
function contentSessionRequest(m, index, reservedAt, ownerInstanceId, now) {
  const remaining = m.validUntil - now;
  if (!Number.isSafeInteger(now) || now < m.validFrom || remaining < 900)
    refuse();
  return {
    RoleArn: m.acceptance.collectorRoleArn,
    RoleSessionName: sessionName(m, index),
    DurationSeconds: Math.min(3600, remaining),
    Policy: JSON.stringify(
      contentPolicy(m, index, reservedAt, ownerInstanceId),
    ),
  };
}
function validateContentSession(
  m,
  index,
  reservedAt,
  ownerInstanceId,
  request,
  response,
  now,
) {
  const expected = contentSessionRequest(
    m,
    index,
    reservedAt,
    ownerInstanceId,
    now,
  );
  if (
    !isDeepStrictEqual(
      { ...request, DurationSeconds: expected.DurationSeconds },
      expected,
    ) ||
    request.DurationSeconds < 900 ||
    request.DurationSeconds > 3600
  )
    refuse();
  const arn = `arn:aws:sts::${m.identity.accountId}:assumed-role/${m.acceptance.collectorRoleArn.split(":role/")[1]}/${expected.RoleSessionName}`;
  if (response.AssumedRoleUser?.Arn !== arn) refuse();
  const credentials = response.Credentials;
  if (
    !credentials ||
    ![
      credentials.AccessKeyId,
      credentials.SecretAccessKey,
      credentials.SessionToken,
    ].every((v) => typeof v === "string" && v.length > 0)
  )
    refuse();
  const expiresAt = Date.parse(credentials.Expiration) / 1000;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > m.validUntil ||
    expiresAt > now + request.DurationSeconds
  )
    refuse();
  return { arn, expiresAt };
}
module.exports = {
  fixtureFolder,
  contentPolicy,
  contentPreflight,
  contentSessionRequest,
  validateContentSession,
};
