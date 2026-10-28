"use strict";
const assert = require("node:assert/strict");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const s3 = require("@aws-sdk/client-s3");
const { awsCli } = require("./coordinator-aws.cjs");
const { canonicalHash } = require("./production-manifest.cjs");
const { createPreparationCapture } = require("./private-capture.cjs");
const c = require("./production-paused-contract.cjs");
const product = "Chronote-gg/Chronote",
  operations = "Chronote-gg/chronote-ops";
const sha = /^[a-f0-9]{40}$/;
function current(r) {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(now >= r.validFrom && now < r.validUntil);
  return now;
}
async function loadPreparationRequest(
  operationId,
  commit,
  expectedHash,
  token,
) {
  assert.match(operationId, /^[a-f0-9-]{36}$/);
  assert.match(commit, sha);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const requestPath = `production-paused-drafts/${operationId}/request.json`;
  const item = await require("./production-private-package.cjs").githubJson(
    `repos/${operations}/contents/${requestPath}?ref=${commit}`,
    "{type,path,encoding,size,content}",
    token,
  );
  assert.equal(item.type, "file");
  assert.equal(item.path, requestPath);
  assert.equal(item.encoding, "base64");
  assert.ok(
    Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 262144,
  );
  const bytes = Buffer.from(item.content, "base64");
  assert.equal(bytes.length, item.size);
  const request = c.parseRequest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );
  assert.equal(request.scope.operationId, operationId);
  assert.equal(canonicalHash(request), expectedHash);
  return request;
}
function sanitizedPreparation(p) {
  return c.artifactPreparationSchema.parse(
    Object.fromEntries(
      Object.keys(c.artifactPreparationSchema.shape).map((key) => [
        key,
        p[key],
      ]),
    ),
  );
}
function receiptFor(request, capture, preparation) {
  return c.artifactSchema.parse({
    schemaVersion: 1,
    requestSha256: canonicalHash(request),
    captureSha256: capture.sha256,
    captureSize: capture.size,
    captureVersionIdSha256: require("node:crypto")
      .createHash("sha256")
      .update(capture.versionId)
      .digest("hex"),
    preparation: sanitizedPreparation(preparation),
  });
}
function rejectOverrides(env) {
  for (const key of Object.keys(env))
    if (
      key.startsWith("AWS_ENDPOINT_URL") ||
      [
        "AWS_PROFILE",
        "AWS_DEFAULT_PROFILE",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_ROLE_ARN",
      ].includes(key)
    )
      assert.ok(!env[key]);
  assert.equal(env.AWS_MAX_ATTEMPTS, "1");
}
async function hostedPreparation(r, env) {
  rejectOverrides(env);
  current(r);
  assert.equal(env.GITHUB_REPOSITORY, product);
  assert.equal(env.GITHUB_REF, "refs/heads/master");
  assert.equal(env.GITHUB_SHA, r.scope.sourceCommit);
  assert.equal(env.GITHUB_RUN_ATTEMPT, "1");
  assert.equal(env.GITHUB_JOB, "prepare-paused-drafts");
  assert.equal(
    env.GITHUB_WORKFLOW_REF,
    `${product}/${c.workflow}@refs/heads/master`,
  );
  assert.equal(env.AWS_REGION, r.scope.region);
  assert.equal(env.AWS_ACCOUNT_ID, r.scope.accountId);
  assert.equal(
    env.PRODUCTION_PAUSED_PREPARATION_ROLE_ARN,
    r.preparationRoleArn,
  );
  const github = require("./production-private-package.cjs").githubJson;
  const run = await github(
    `repos/${product}/actions/runs/${env.GITHUB_RUN_ID}`,
    "{id,status,conclusion,head_sha,head_branch,event,path,run_attempt,repository:.repository.full_name,repositoryId:(.repository.id|tostring),repositoryOwnerId:(.repository.owner.id|tostring),actorId:(.actor.id|tostring)}",
    env.GH_TOKEN,
  );
  assert.equal(String(run.id), env.GITHUB_RUN_ID);
  assert.equal(run.status, "in_progress");
  assert.equal(run.conclusion, null);
  assert.equal(run.head_sha, r.scope.sourceCommit);
  assert.equal(run.head_branch, "master");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.path, c.workflow);
  assert.equal(run.run_attempt, 1);
  assert.equal(run.repository, product);
  assert.equal(String(run.repositoryId), env.GITHUB_REPOSITORY_ID);
  assert.equal(String(run.repositoryOwnerId), env.GITHUB_REPOSITORY_OWNER_ID);
  const jobs = await github(
    `repos/${product}/actions/runs/${env.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`,
    "{total_count,jobs:[.jobs[]|{name,status,conclusion,head_sha}]}",
    env.GH_TOKEN,
  );
  assert.equal(jobs.total_count, jobs.jobs.length);
  assert.equal(jobs.jobs.length, 1);
  assert.deepEqual(jobs.jobs[0], {
    name: c.jobName,
    status: "in_progress",
    conclusion: null,
    head_sha: r.scope.sourceCommit,
  });
  const caller = await awsCli(
    "sts",
    "get-caller-identity",
    {},
    { region: r.scope.region, maxAttempts: 1 },
  );
  const sessionArn = `arn:aws:sts::${r.scope.accountId}:assumed-role/${r.preparationRoleArn.split(":role/")[1]}/paused-preparation-${env.GITHUB_RUN_ID}-1`;
  assert.equal(caller.Account, r.scope.accountId);
  assert.equal(caller.Arn, sessionArn);
  current(r);
  return c.preparationSchema.parse({
    repository: product,
    repositoryId: String(run.repositoryId),
    repositoryOwnerId: String(run.repositoryOwnerId),
    workflow: c.workflow,
    jobName: c.jobName,
    runId: env.GITHUB_RUN_ID,
    runAttempt: "1",
    sourceCommit: r.scope.sourceCommit,
    actorId: run.actorId,
    accountId: r.scope.accountId,
    sessionArn,
    roleArn: r.preparationRoleArn,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
  });
}
async function pages(r, id, kind, aws) {
  const rows = [],
    cursors = new Set(),
    keys = new Set();
  let cursor;
  for (let page = 0; page < r.maxPages; page++) {
    current(r);
    const result = await aws(
      "query",
      require("./production-paused-metadata.cjs").pausedQueryInput(
        r.scope,
        id,
        kind,
        cursor,
      ),
    );
    current(r);
    assert.ok(Array.isArray(result.Items));
    for (const item of result.Items) {
      const row = (kind === "parent" ? c.parentSchema : c.segmentSchema).parse(
        unmarshall(item),
      );
      assert.equal(row.uploadId, id.uploadId);
      assert.equal(row.ownerUserId, id.ownerUserId);
      const key = kind === "parent" ? row.uploadId : row.segmentKey;
      assert.ok(!keys.has(key));
      keys.add(key);
      rows.push(row);
      assert.ok(rows.length <= r.maxRows);
    }
    cursor = result.LastEvaluatedKey;
    if (!cursor) return rows;
    const key = unmarshall(cursor);
    assert.deepEqual(
      Object.keys(key).sort(),
      kind === "parent" ? ["uploadId"] : ["segmentKey", "uploadId"],
    );
    assert.equal(key.uploadId, id.uploadId);
    if (kind !== "parent") assert.ok(key.segmentKey);
    const hash = canonicalHash(key);
    assert.ok(!cursors.has(hash));
    cursors.add(hash);
  }
  throw Error("paused_preparation_page_bound");
}
function validateRows(r, parents, segments) {
  const inputs = new Map();
  for (const id of r.cohort) {
    const parent = parents.find((p) => p.uploadId === id.uploadId),
      parts = segments.filter((s) => s.uploadId === id.uploadId);
    assert.ok(parent);
    assert.equal(parent.sourceManifest.length, id.sourceCount);
    assert.equal(
      new Set(parent.sourceManifest.map((s) => s.sourceId)).size,
      id.sourceCount,
    );
    assert.equal(parent.segmentCount, parts.length);
    assert.equal(
      parent.uploadedSegmentCount,
      parts.filter((s) => ["uploaded", "submitted"].includes(s.status)).length,
    );
    const prefix = `personal-media-uploads/${id.ownerUserId}/${id.uploadId}/`;
    assert.ok(
      parent.sourceS3Key === prefix + "segments/" ||
        [...parent.sourceManifest, ...parts].some(
          (s) => s.sourceS3Key === parent.sourceS3Key,
        ),
    );
    for (const part of parts)
      assert.ok(
        parent.sourceManifest.some(
          (s) => s.sourceId === part.sourceId && s.kind === part.kind,
        ),
      );
    for (const source of [...parent.sourceManifest, ...parts]) {
      if (!source.sourceS3Key) {
        assert.equal(source.fileSize, undefined);
        continue;
      }
      assert.ok(
        source.sourceS3Key.startsWith(prefix) &&
          source.fileSize > 0 &&
          source.contentType,
      );
      const object = {
        uploadId: id.uploadId,
        ownerUserId: id.ownerUserId,
        key: source.sourceS3Key,
        size: source.fileSize,
        contentType: source.contentType,
      };
      if (inputs.has(object.key))
        assert.deepEqual(inputs.get(object.key), object);
      else inputs.set(object.key, object);
    }
    assert.ok([...inputs.values()].some((o) => o.uploadId === id.uploadId));
  }
  assert.deepEqual(
    [...inputs.keys()].sort(),
    r.sourceObjects.map((o) => o.key).sort(),
  );
  return [...inputs.values()];
}
async function readSourceObject(input, selected, send) {
  let head = await send("HeadObject", {
    Key: input.key,
    ChecksumMode: "ENABLED",
    ...(selected.versionId ? { VersionId: selected.versionId } : {}),
  });
  assert.ok(head.VersionId && head.VersionId !== "null");
  if (!selected.versionId) {
    const version = head.VersionId;
    head = await send("HeadObject", {
      Key: input.key,
      VersionId: version,
      ChecksumMode: "ENABLED",
    });
    assert.equal(head.VersionId, version);
  } else assert.equal(head.VersionId, selected.versionId);
  assert.equal(head.ContentLength, input.size);
  assert.equal(head.ContentType, input.contentType);
  assert.ok(!head.DeleteMarker);
  if (head.ServerSideEncryption === "aws:kms") {
    assert.ok(
      head.BucketKeyEnabled === undefined || head.BucketKeyEnabled === false,
    );
    // Native S3 omits this header when bucket keys are disabled.
    head.BucketKeyEnabled = false;
  }
  return capturedObject(input, selected, head);
}
function capturedObject(input, selected, head) {
  const checksums = Object.fromEntries(
    [
      "ChecksumSHA256",
      "ChecksumSHA1",
      "ChecksumCRC32",
      "ChecksumCRC32C",
      "ChecksumCRC64NVME",
    ]
      .filter((k) => head[k] !== undefined)
      .map((k) => [k, head[k]]),
  );
  for (const [field, predicate] of Object.entries(
    selected.requiredChecksums ?? {},
  ))
    assert.equal(head[field], predicate.value);
  return c.objectSchema.parse({
    ...input,
    versionId: head.VersionId,
    checksums,
    ...(selected.requiredChecksums
      ? { requiredChecksums: selected.requiredChecksums }
      : {}),
    checksumType: head.ChecksumType ?? "unavailable",
    ...(head.ServerSideEncryption
      ? {
          encryption: {
            serverSideEncryption: head.ServerSideEncryption,
            ...(head.SSEKMSKeyId ? { sseKmsKeyId: head.SSEKMSKeyId } : {}),
            ...(head.BucketKeyEnabled !== undefined
              ? { bucketKeyEnabled: head.BucketKeyEnabled }
              : {}),
          },
        }
      : {}),
  });
}
async function collect(r) {
  const aws = (operation, input) =>
    awsCli("dynamodb", operation, input, {
      region: r.scope.region,
      maxAttempts: 1,
    });
  const sdk = new s3.S3Client({
    region: r.scope.region,
    maxAttempts: 1,
    endpoint: `https://s3.${r.scope.region}.amazonaws.com`,
  });
  const send = async (name, input = {}) => {
    current(r);
    const result = await sdk.send(
      new s3[name + "Command"]({
        Bucket: r.scope.bucket,
        ExpectedBucketOwner: r.scope.accountId,
        ...input,
      }),
      { abortSignal: AbortSignal.timeout(30000) },
    );
    current(r);
    return result;
  };
  for (const key of ["personalJob", "personalSegment"]) {
    const table = (
      await aws("describe-table", { TableName: r.scope[key + "Table"] })
    ).Table;
    assert.equal(table?.TableArn, r.resourceArns[key]);
    assert.equal(
      table?.SSEDescription?.KMSMasterKeyArn,
      r.resourceArns[key + "KmsKeyArn"],
    );
  }
  const parents = [],
    segments = [];
  for (const id of r.cohort) {
    const parent = await pages(r, id, "parent", aws);
    assert.equal(parent.length, 1);
    parents.push(parent[0]);
    segments.push(...(await pages(r, id, "segments", aws)));
  }
  assert.ok(parents.length + segments.length <= r.maxRows);
  const objects = [];
  for (const input of validateRows(r, parents, segments))
    objects.push(
      await readSourceObject(
        input,
        r.sourceObjects.find((o) => o.key === input.key),
        send,
      ),
    );
  const ttl = async (table) => {
    const result = await aws("describe-time-to-live", { TableName: table });
    return { TimeToLiveDescription: result.TimeToLiveDescription };
  };
  const versioning = await send("GetBucketVersioning");
  let lifecycle;
  try {
    lifecycle = await send("GetBucketLifecycleConfiguration");
  } catch (error) {
    if (error.name !== "NoSuchLifecycleConfiguration") throw error;
    lifecycle = { Rules: [] };
  }
  const storageObservations = c.storageSchema.parse({
    observedAt: current(r),
    personalJobTtl: await ttl(r.scope.personalJobTable),
    personalSegmentTtl: await ttl(r.scope.personalSegmentTable),
    personalJobKmsKeyArn: r.resourceArns.personalJobKmsKeyArn,
    personalSegmentKmsKeyArn: r.resourceArns.personalSegmentKmsKeyArn,
    bucketVersioning: {
      Status: versioning.Status,
      ...(versioning.MFADelete ? { MFADelete: versioning.MFADelete } : {}),
    },
    bucketLifecycle: { Rules: lifecycle.Rules },
  });
  return { parents, segments, objects, storageObservations };
}
async function prepareOriginalPausedDrafts() {
  assert.equal(arguments.length, 0);
  const env = process.env;
  const request = await loadPreparationRequest(
    env.PAUSED_PREPARATION_OPERATION_ID,
    env.PAUSED_PREPARATION_REQUEST_COMMIT,
    env.PAUSED_PREPARATION_REQUEST_SHA256,
    env.INTRODUCTION_OPS_READ_TOKEN,
  );
  const preparation = await hostedPreparation(request, env),
    rows = await collect(request);
  assert.deepEqual(await hostedPreparation(request, env), preparation);
  const capture = c.assertCapture(
    {
      schemaVersion: 1,
      predicate: request.predicate,
      requestSha256: canonicalHash(request),
      scope: request.scope,
      cohort: request.cohort,
      ...rows,
      preparation,
    },
    request,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(capture)) <= 262144);
  const reference = await createPreparationCapture({
    preparation: c.preparationIdentity(request),
    binding: request.storeBinding,
  }).capture(capture);
  assert.deepEqual(await hostedPreparation(request, env), preparation);
  return receiptFor(request, reference, preparation);
}
async function runCli(argv = process.argv.slice(2), output = console) {
  try {
    assert.deepEqual(argv, []);
    const receipt = await prepareOriginalPausedDrafts();
    const directory = path.join(
      process.env.GITHUB_WORKSPACE,
      ".paused-preparation",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "preparation.json"),
      JSON.stringify(receipt),
      { flag: "wx" },
    );
    output.log(JSON.stringify({ status: "prepared", schemaVersion: 1 }));
    return 0;
  } catch {
    output.error(
      JSON.stringify({
        status: "refused",
        reason: "paused_preparation_prerequisite",
      }),
    );
    return 1;
  }
}
if (require.main === module)
  runCli().then((code) => {
    process.exitCode = code;
  });
module.exports = {
  prepareOriginalPausedDrafts,
  runCli,
  loadPreparationRequest,
  receiptFor,
  sanitizedPreparation,
};
