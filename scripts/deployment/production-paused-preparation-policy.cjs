"use strict";
const assert = require("node:assert/strict");
const { z } = require("zod");
const contract = require("./production-paused-contract.cjs");
const { canonicalHash } = require("./production-manifest.cjs");
const repositoryIdentity = z
  .object({
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    repositoryOwnerId: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
function preparationRoleProposal(request, identity) {
  const r = contract.parseRequest(request),
    ids = repositoryIdentity.parse(identity),
    s = r.scope;
  for (const name of [s.personalJobTable, s.personalSegmentTable])
    assert.match(name, /^[a-zA-Z0-9_.-]+$/);
  const namespace = `production-introduction-preparation/${s.operationId}/${s.sourceCommit}`;
  const allow = (Sid, Action, Resource, Condition) => ({
    Sid,
    Effect: "Allow",
    Action,
    Resource,
    ...(Condition ? { Condition } : {}),
  });
  const leading = {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": r.cohort.map((row) => row.uploadId),
    },
  };
  const via = (service) => ({
    "kms:ViaService": `${service}.${s.region}.amazonaws.com`,
    "kms:CallerAccount": s.accountId,
  });
  const personal = [r.resourceArns.personalJob, r.resourceArns.personalSegment];
  const statements = [
    allow("PreparationPersonalQuery", ["dynamodb:Query"], personal, leading),
    allow(
      "PreparationPersonalSettings",
      ["dynamodb:DescribeTable", "dynamodb:DescribeTimeToLive"],
      personal,
    ),
    allow(
      "PreparationSourceSettings",
      ["s3:GetBucketVersioning", "s3:GetLifecycleConfiguration"],
      r.resourceArns.bucket,
    ),
    allow(
      "PreparationCaptureSettings",
      [
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketOwnershipControls",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketPolicyStatus",
        "s3:GetBucketPolicy",
        "s3:GetEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
      ],
      `arn:aws:s3:::${r.storeBinding.bucket}`,
    ),
    allow(
      "PreparationCaptureWrite",
      ["s3:PutObject"],
      `arn:aws:s3:::${r.storeBinding.bucket}/${namespace}/*`,
      {
        StringEquals: {
          "s3:x-amz-server-side-encryption": "aws:kms",
          "s3:x-amz-server-side-encryption-aws-kms-key-id":
            r.storeBinding.kmsKeyArn,
        },
      },
    ),
    allow(
      "PreparationCaptureRead",
      ["s3:GetObjectVersion"],
      `arn:aws:s3:::${r.storeBinding.bucket}/${namespace}/*`,
    ),
    allow(
      "PreparationCaptureKey",
      ["kms:GenerateDataKey", "kms:Decrypt"],
      r.storeBinding.kmsKeyArn,
      {
        StringEquals: via("s3"),
        StringLike: {
          "kms:EncryptionContext:aws:s3:arn": `arn:aws:s3:::${r.storeBinding.bucket}/${namespace}/*`,
        },
      },
    ),
  ];
  for (const table of ["personalJob", "personalSegment"])
    statements.push(
      allow(
        `Preparation${table}Key`,
        ["kms:Decrypt"],
        r.resourceArns[table + "KmsKeyArn"],
        {
          StringEquals: {
            ...via("dynamodb"),
            "kms:EncryptionContext:aws:dynamodb:tableName": s[table + "Table"],
          },
        },
      ),
    );
  const unresolved = [];
  for (const [index, object] of r.sourceObjects.entries()) {
    assert.ok(
      !/[*?]/.test(object.key),
      "unsupported literal wildcard object key",
    );
    const resource = `arn:aws:s3:::${s.bucket}/${object.key}`;
    statements.push(
      allow(
        `PreparationSource${index}`,
        object.versionId
          ? ["s3:GetObjectVersion"]
          : ["s3:GetObject", "s3:GetObjectVersion"],
        resource,
        object.versionId
          ? { StringEquals: { "s3:VersionId": object.versionId } }
          : undefined,
      ),
    );
    if (!object.encryption)
      unresolved.push({ key: object.key, field: "encryption" });
    else if (object.encryption.serverSideEncryption === "aws:kms") {
      const key = object.encryption.sseKmsKeyId;
      if (!key)
        unresolved.push({ key: object.key, field: "encryption.sseKmsKeyId" });
      // Versioned general-purpose buckets need Decrypt for checksum HEAD; directory buckets are unsupported.
      else
        statements.push(
          allow(`PreparationSourceKey${index}`, ["kms:Decrypt"], key, {
            StringEquals: {
              ...via("s3"),
              "kms:EncryptionContext:aws:s3:arn": resource,
            },
          }),
        );
    }
  }
  return {
    roleArn: r.preparationRoleArn,
    trust: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: "sts:AssumeRoleWithWebIdentity",
          Principal: {
            Federated: `arn:aws:iam::${s.accountId}:oidc-provider/token.actions.githubusercontent.com`,
          },
          Condition: {
            StringEquals: {
              "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
              "token.actions.githubusercontent.com:sub":
                "repo:Chronote-gg/Chronote:ref:refs/heads/master",
            },
            StringLike: { "sts:RoleSessionName": "paused-preparation-*-1" },
          },
        },
      ],
    },
    permissions: { Version: "2012-10-17", Statement: statements },
    matcherInputs: {
      ...ids,
      repository: "Chronote-gg/Chronote",
      ref: "refs/heads/master",
      workflow: contract.workflow,
      jobName: contract.jobName,
      jobId: "prepare-paused-drafts",
      runAttempt: "1",
      sessionNamePattern: "paused-preparation-<runId>-1",
      sourceCommit: s.sourceCommit,
      requestSha256: canonicalHash(r),
      scope: s,
      cohort: r.cohort,
      namespace,
    },
    unresolved,
    limits: [
      "IAM source-object read grants permit content; the native producer dispatches HEAD only.",
      "This pure proposal neither verifies nor installs effective permissions.",
      "Repository/workflow identity and actual role session still require the native hosted checks.",
    ],
  };
}
module.exports = { preparationRoleProposal };
