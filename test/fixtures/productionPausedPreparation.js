import { marshall } from "@aws-sdk/util-dynamodb";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { zipSync, strToU8 } from "fflate";
import { canonicalHash } from "../../scripts/deployment/production-manifest.cjs";
import { bindingHash } from "../../scripts/deployment/binding-hash.cjs";
import {
  scopeFor,
  workflow,
  jobName,
} from "../../scripts/deployment/production-paused-contract.cjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function preparationSegment(id, key) {
  return {
    uploadId: id.uploadId,
    ownerUserId: id.ownerUserId,
    segmentKey: "mic#000000",
    sourceId: "mic",
    sequence: 0,
    kind: "owner_mic",
    label: "PRIVATE SENTINEL",
    sourceS3Key: key,
    contentType: "audio/wav",
    fileSize: 10,
    checksumSha256: "a".repeat(64),
    durationMillis: 5,
    startedAt: "before",
    endedAt: "before",
    status: "uploaded",
    createdAt: "before",
    updatedAt: "before",
    uploadedAt: "before",
  };
}
export function pausedPreparationFixture(manifest) {
  const scope = scopeFor(manifest),
    account = scope.accountId,
    region = scope.region;
  const keyArn = `arn:aws:kms:${region}:${account}:key/00000000-0000-0000-0000-000000000001`;
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [] });
  const request = {
    schemaVersion: 1,
    predicate: "preserve-two-desktop-drafts-v1",
    scope,
    cohort: ["one", "two"].map((uploadId) => ({
      uploadId,
      ownerUserId: "owner",
      sourceCount: 1,
    })),
    resourceArns: {
      personalJob: `arn:aws:dynamodb:${region}:${account}:table/${scope.personalJobTable}`,
      personalSegment: `arn:aws:dynamodb:${region}:${account}:table/${scope.personalSegmentTable}`,
      deploymentControl: `arn:aws:dynamodb:${region}:${account}:table/${scope.deploymentControlTable}`,
      bucket: `arn:aws:s3:::${scope.bucket}`,
      personalJobKmsKeyArn: keyArn,
      personalSegmentKmsKeyArn: keyArn,
    },
    sourceObjects: ["one", "two"].map((id) => ({
      key: `personal-media-uploads/owner/${id}/mic-0.wav`,
    })),
    storeBinding: {
      kind: "versioned-private-s3-v1",
      storeId: "preservation-evidence",
      bucket: "private-preservation-evidence",
      accountId: account,
      region,
      kmsKeyArn: keyArn,
      canonicalPolicySha256: bindingHash(JSON.parse(policy)),
      lifecycleSha256: digest("null"),
      retentionUntil: 400,
      administratorTrustSha256: "f".repeat(64),
    },
    preparationRoleArn: `arn:aws:iam::${account}:role/paused-preparation`,
    validFrom: 100,
    validUntil: 300,
    maxPages: 5,
    maxRows: 20,
  };
  const parents = request.cohort.map((id) => ({
    uploadId: id.uploadId,
    ownerUserId: id.ownerUserId,
    status: "pending_upload",
    mediaKind: "audio",
    uploadOrigin: "desktop_recording",
    sourceS3Key: `personal-media-uploads/owner/${id.uploadId}/segments/`,
    sourceManifest: [
      {
        sourceId: "mic",
        kind: "owner_mic",
        label: "PRIVATE SENTINEL",
        originalFileName: "PRIVATE SENTINEL",
      },
    ],
    contentType: "audio/wav",
    fileSize: 0,
    createdAt: "before",
    updatedAt: "before",
    segmentCount: 1,
    uploadedSegmentCount: 1,
    title: "PRIVATE SENTINEL",
  }));
  const segments = request.cohort.map((id, i) =>
    preparationSegment(id, request.sourceObjects[i].key),
  );
  const state = {
    completed: false,
    capture: null,
    reference: null,
    receipt: null,
    archive: null,
    badRun: false,
    duplicateJob: false,
    lostAck: false,
  };
  const env = {
    GITHUB_REPOSITORY: "Chronote-gg/Chronote",
    GITHUB_REPOSITORY_ID: "1",
    GITHUB_REPOSITORY_OWNER_ID: "2",
    GITHUB_REF: "refs/heads/master",
    GITHUB_SHA: scope.sourceCommit,
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "20",
    GITHUB_JOB: "prepare-paused-drafts",
    GITHUB_WORKFLOW_REF: `Chronote-gg/Chronote/${workflow}@refs/heads/master`,
    AWS_ACCOUNT_ID: account,
    AWS_REGION: region,
    AWS_MAX_ATTEMPTS: "1",
    PRODUCTION_PAUSED_PREPARATION_ROLE_ARN: request.preparationRoleArn,
    PAUSED_PREPARATION_OPERATION_ID: scope.operationId,
    PAUSED_PREPARATION_REQUEST_COMMIT: "b".repeat(40),
    PAUSED_PREPARATION_REQUEST_SHA256: canonicalHash(request),
    INTRODUCTION_OPS_READ_TOKEN: "synthetic-ops",
    GH_TOKEN: "synthetic-github",
  };
  const run = () => ({
    id: 20,
    status: state.completed ? "completed" : "in_progress",
    conclusion: state.completed ? "success" : null,
    head_sha: state.badRun ? "c".repeat(40) : scope.sourceCommit,
    head_branch: "master",
    event: "workflow_dispatch",
    path: workflow,
    run_attempt: 1,
    repository: "Chronote-gg/Chronote",
    repositoryId: "1",
    repositoryOwnerId: "2",
    actorId: "7",
  });
  function github(endpoint) {
    if (endpoint.includes("/contents/")) {
      const content = Buffer.from(JSON.stringify(request));
      return {
        type: "file",
        path: `production-paused-drafts/${scope.operationId}/request.json`,
        encoding: "base64",
        size: content.length,
        content: content.toString("base64"),
      };
    }
    if (endpoint.endsWith("/jobs?per_page=100")) {
      const jobs = [
        {
          name: jobName,
          status: run().status,
          conclusion: run().conclusion,
          head_sha: run().head_sha,
        },
      ];
      if (state.duplicateJob) jobs.push(jobs[0]);
      return { total_count: jobs.length, jobs };
    }
    if (endpoint.endsWith("/artifacts/30"))
      return {
        id: 30,
        name: "paused-draft-preparation",
        expired: false,
        workflow_run: { id: 20, head_sha: scope.sourceCommit },
        size_in_bytes: state.archive.length,
        digest: `sha256:${digest(state.archive)}`,
      };
    if (endpoint.endsWith("/runs/20")) return run();
    throw Error(`unexpected synthetic github endpoint ${endpoint}`);
  }
  function aws(service, operation, input) {
    if (service === "sts")
      return {
        Account: account,
        Arn: `arn:aws:sts::${account}:assumed-role/paused-preparation/paused-preparation-20-1`,
      };
    if (operation === "describe-table") {
      const key =
        input.TableName === scope.personalJobTable
          ? "personalJob"
          : "personalSegment";
      return {
        Table: {
          TableArn: request.resourceArns[key],
          SSEDescription: { KMSMasterKeyArn: keyArn },
        },
      };
    }
    if (operation === "describe-time-to-live")
      return { TimeToLiveDescription: { TimeToLiveStatus: "DISABLED" } };
    if (operation === "query") {
      const parent = input.TableName === scope.personalJobTable,
        id = input.ExpressionAttributeValues[":uploadId"].S;
      const fields = new Set(Object.values(input.ExpressionAttributeNames));
      const rows = (parent ? parents : segments)
        .filter((r) => r.uploadId === id)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(([key]) => fields.has(key)),
          ),
        );
      if (parent)
        for (const row of rows)
          row.sourceManifest = row.sourceManifest.map((s) =>
            Object.fromEntries(
              Object.entries(s).filter(([key]) => fields.has(key)),
            ),
          );
      return { Items: rows.map((row) => marshall(row)) };
    }
    throw Error(`unexpected synthetic AWS ${service} ${operation}`);
  }
  function sourceMetadata(name) {
    if (name === "HeadObject")
      return {
        VersionId: "original-v1",
        ContentLength: 10,
        ContentType: "audio/wav",
      };
    if (name === "GetBucketVersioning") return { Status: "Enabled" };
    if (name === "GetBucketLifecycleConfiguration") return { Rules: [] };
    throw Error("forbidden original object operation");
  }
  function send(command) {
    const name = command.constructor.name.replace(/Command$/, ""),
      input = command.input;
    if (input.Bucket === scope.bucket) return sourceMetadata(name);
    if (name === "GetBucketLocation") return { LocationConstraint: region };
    if (name === "GetBucketVersioning") return { Status: "Enabled" };
    if (name === "GetBucketOwnershipControls")
      return {
        OwnershipControls: {
          Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }],
        },
      };
    if (name === "GetPublicAccessBlock")
      return {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        },
      };
    if (name === "GetBucketPolicyStatus")
      return { PolicyStatus: { IsPublic: false } };
    if (name === "GetBucketPolicy") return { Policy: policy };
    if (name === "GetBucketEncryption")
      return {
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: {
                SSEAlgorithm: "aws:kms",
                KMSMasterKeyID: keyArn,
              },
              BucketKeyEnabled: false,
            },
          ],
        },
      };
    if (name === "GetBucketLifecycleConfiguration")
      throw Object.assign(Error("no lifecycle"), {
        name: "NoSuchLifecycleConfiguration",
      });
    if (name === "PutObject") {
      state.capture = Buffer.from(input.Body);
      state.reference = {
        storeId: request.storeBinding.storeId,
        namespace: `production-introduction-preparation/${scope.operationId}/${scope.sourceCommit}`,
        key: input.Key,
        sha256: digest(state.capture),
        size: state.capture.length,
        versionId: "capture-v1",
      };
      if (state.lostAck) throw Error("lost ACK");
      return { VersionId: "capture-v1" };
    }
    if (name === "GetObject")
      return {
        VersionId: "capture-v1",
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: keyArn,
        BucketKeyEnabled: false,
        ContentLength: state.capture.length,
        Body: state.capture.toString("utf8"),
      };
    throw Error(`unexpected capture operation ${name}`);
  }
  function finish(receipt) {
    state.receipt = receipt;
    state.completed = true;
    state.archive = Buffer.from(
      zipSync({
        "preparation.json": [
          strToU8(JSON.stringify(receipt)),
          { mtime: new Date("2026-10-26T00:00:00Z") },
        ],
      }),
    );
    return {
      predicate: request.predicate,
      scope,
      cohort: request.cohort,
      request: {
        commit: env.PAUSED_PREPARATION_REQUEST_COMMIT,
        sha256: canonicalHash(request),
      },
      storeBinding: request.storeBinding,
      capture: state.reference,
      preparation: { ...receipt.preparation, artifactId: "30" },
    };
  }
  return {
    request,
    env,
    state,
    github,
    aws,
    send,
    finish,
    parents,
    segments,
    digest,
  };
}
