"use strict";
const { isDeepStrictEqual: same } = require("node:util");
const { canonicalHash } = require("./production-manifest.cjs");
const policyName = "paused-desktop-draft-preservation-v1";
function refuse() {
  throw Error("paused_effective_policy_scope_prerequisite");
}
function exact(value) {
  if (typeof value !== "string" || !value || /[*?]/.test(value)) refuse();
  return value;
}
function tableArn(m, name) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name)) refuse();
  return `arn:aws:dynamodb:${m.identity.region}:${m.identity.accountId}:table/${name}`;
}
function keyArn(m, value) {
  const prefix = `arn:aws:kms:${m.identity.region}:${m.identity.accountId}:key/`;
  if (
    !value?.startsWith(prefix) ||
    !/^[a-f0-9-]{36}$/.test(value.slice(prefix.length))
  )
    refuse();
  return value;
}
function preservationPolicy(scope, purpose) {
  const m = scope.manifest;
  if (
    !["introduction", "collector"].includes(purpose) ||
    scope.identities.length !== 2 ||
    new Set(scope.identities.map((r) => r.uploadId)).size !== 2
  )
    refuse();
  const ids = Array.from(scope.identities, (r) => exact(r.uploadId));
  const tables = ["personalJob", "personalSegment"].map((name) =>
    tableArn(m, m.resources.tables[name]),
  );
  const leading = (keys) => ({
    "ForAllValues:StringEquals": { "dynamodb:LeadingKeys": keys },
  });
  const statement = (Sid, Action, Resource, Condition) => ({
    Sid,
    Effect: "Allow",
    Action,
    Resource,
    ...(Condition ? { Condition } : {}),
  });
  const statements = [
    statement("PausedPersonalQuery", ["dynamodb:Query"], tables, leading(ids)),
    statement("PausedPersonalTtl", ["dynamodb:DescribeTimeToLive"], tables),
    statement(
      "PausedBucketSettings",
      ["s3:GetBucketVersioning", "s3:GetLifecycleConfiguration"],
      `arn:aws:s3:::${exact(m.resources.bucket)}`,
    ),
    statement(
      "PausedMarkerRead",
      ["dynamodb:GetItem"],
      tableArn(m, m.resources.tables.deploymentControl),
      leading(ids.map((id) => `UPLOAD#${id}`)),
    ),
  ];
  if (purpose === "introduction") {
    statements.push(
      statement(
        "PausedPersonalConditions",
        ["dynamodb:ConditionCheckItem"],
        tables,
        leading(ids),
      ),
    );
    statements.push(
      statement(
        "PausedMarkerInitialize",
        ["dynamodb:PutItem"],
        tableArn(m, m.resources.tables.deploymentControl),
        leading(ids.map((id) => `UPLOAD#${id}`)),
      ),
    );
  }
  for (const [index, object] of scope.objects.entries()) {
    const owner = scope.identities.find(
      (id) =>
        id.uploadId === object.uploadId &&
        id.ownerUserId === object.ownerUserId,
    );
    if (
      !owner ||
      !exact(object.key).startsWith(
        `personal-media-uploads/${exact(owner.ownerUserId)}/${owner.uploadId}/`,
      ) ||
      object.versionId === "null"
    )
      refuse();
    statements.push(
      statement(
        `PreservedObject${index}`,
        ["s3:GetObjectVersion"],
        `arn:aws:s3:::${m.resources.bucket}/${object.key}`,
        { StringEquals: { "s3:VersionId": exact(object.versionId) } },
      ),
    );
    if (object.encryption?.serverSideEncryption === "aws:kms")
      statements.push(
        statement(
          `PreservedObjectKey${index}`,
          ["kms:Decrypt"],
          keyArn(m, object.encryption.sseKmsKeyId),
          {
            StringEquals: {
              "kms:ViaService": `s3.${m.identity.region}.amazonaws.com`,
              "kms:CallerAccount": m.identity.accountId,
              "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::${m.resources.bucket}/${object.key}`,
            },
          },
        ),
      );
  }
  if (
    !scope.objects.length ||
    new Set(scope.objects.map((o) => o.key)).size !== scope.objects.length
  )
    refuse();
  for (const name of ["personalJob", "personalSegment"])
    statements.push(
      statement(
        `Paused${name}Key`,
        ["kms:Decrypt"],
        keyArn(m, scope.request.resourceArns[`${name}KmsKeyArn`]),
        {
          StringEquals: {
            "kms:ViaService": `dynamodb.${m.identity.region}.amazonaws.com`,
            "kms:CallerAccount": m.identity.accountId,
            "kms:EncryptionContext:aws:dynamodb:tableName":
              m.resources.tables[name],
          },
        },
      ),
    );
  return { Version: "2012-10-17", Statement: statements };
}
function fixtureDenials(m) {
  if (
    m.resources.artifactPrefixes.length !== 1 ||
    !/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]*\/)+$/.test(
      m.resources.artifactPrefixes[0],
    ) ||
    m.resources.artifactPrefixes[0].startsWith("personal-media-uploads/")
  )
    refuse();
  const component = (value) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) refuse();
    return value;
  };
  const objects = Array.from(m.handoff.grants).flatMap((g) => {
    const folder = `arn:aws:s3:::${m.resources.bucket}/${m.resources.artifactPrefixes[0]}${component(g.guildId)}/${component(g.voiceChannelId)}_${component(g.meetingId)}_????-??-??T??-??-??.???Z/`;
    return ["context", "transcription"].map(
      (kind) => `${folder}checkpoints/v1/*/${kind}/*`,
    );
  });
  return [
    {
      Sid: "NoCheckpointTextInputs",
      Effect: "Deny",
      Action: ["s3:GetObject", "s3:GetObjectVersion"],
      Resource: objects,
    },
    {
      Sid: "NoCheckpointTextKey",
      Effect: "Deny",
      Action: ["kms:Decrypt"],
      Resource: keyArn(m, m.acceptance.storageKeyArn),
      Condition: {
        StringLike: { "kms:EncryptionContext:aws:s3:arn": objects },
      },
    },
  ];
}
function assertOtherStatements(scope, role, entry) {
  for (const s of entry.document.Statement) {
    if (s.Effect === "Deny") {
      if (
        role.purpose !== "collector" ||
        entry.name !== "bounded-fixture-collection" ||
        !fixtureDenials(scope.manifest).some((expected) => same(s, expected))
      )
        refuse();
    } else if (
      s.Effect !== "Allow" ||
      s.NotAction ||
      s.NotResource ||
      s.Principal ||
      s.NotPrincipal
    )
      refuse();
    const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
    if (
      actions.some(
        (action) => typeof action !== "string" || /[*?]/.test(action),
      )
    )
      refuse();
    if (
      role.purpose === "collector" &&
      actions.some((action) =>
        /^(?:dynamodb:(?:PutItem|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems)|s3:(?:PutObject|DeleteObject|DeleteObjectVersion))$/i.test(
          action,
        ),
      )
    )
      refuse();
  }
}
function assertPausedPolicy(scope, roles, purpose) {
  const role = roles.find((r) => r.purpose === purpose);
  if (
    !role ||
    role.boundary ||
    role.attached.length ||
    roles.filter((r) => r.purpose === purpose).length !== 1
  )
    refuse();
  const expectedArn =
    purpose === "introduction"
      ? scope.manifest.identity.roleArn
      : scope.manifest.acceptance.collectorRoleArn;
  if (role.arn !== expectedArn) refuse();
  const expected = preservationPolicy(scope, purpose),
    matches = role.inline.filter((p) => p.name === policyName);
  if (matches.length !== 1 || !same(matches[0].document, expected)) refuse();
  for (const entry of role.inline) assertOtherStatements(scope, role, entry);
  return {
    purpose,
    arn: role.arn,
    roleId: role.roleId,
    policySha256: canonicalHash(expected),
  };
}
module.exports = {
  preservationPolicy,
  assertPausedPolicy,
  fixtureDenials,
  policyName,
};
