"use strict";
const { createHash } = require("node:crypto");
const { isDeepStrictEqual, promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const { awsCli } = require("./coordinator-aws.cjs");
const {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const {
  fixtureFolder,
  contentSessionRequest,
  validateContentSession,
} = require("./production-content-policy.cjs");
const {
  loadAcceptancePackage,
  readCollectionBinding,
  verifyOwnershipEvidence,
} = require("./production-private-package.cjs");
const {
  createProductionAws,
  createAcceptanceReadAws,
} = require("./production-aws.cjs");
const { createInventoryReader } = require("./production-inventory-adapter.cjs");
const {
  createCandidateInspection,
  candidateSlot,
} = require("./production-candidate.cjs");
const {
  readPinnedSupplement,
  verifySupplement,
} = require("./production-acceptance-supplement.cjs");
const collections = new WeakMap();
const exec = promisify(execFile);
const MAX_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_FIXTURE_BYTES = 256 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
function refuse() {
  throw Error("fixture_content_refused");
}
function current(binding, deadline) {
  if (
    now() < binding.manifest.validFrom ||
    now() >= Math.min(binding.manifest.validUntil, deadline)
  )
    refuse();
}
function exactGrant(m, index, row) {
  const grant =
    require("../../dist/types/productionIntroduction.js").fixtureGrantSchema.parse(
      row,
    );
  if (
    grant.state !== "consumed" ||
    grant.holdId !== m.holdId ||
    grant.introductionId !== m.introductionId ||
    grant.revision !== 1 ||
    !Object.entries(m.handoff.grants[index]).every(([key, value]) =>
      isDeepStrictEqual(value, grant[key]),
    ) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      grant.ownership.ownerInstanceId,
    )
  )
    refuse();
  return grant;
}
function projection(fields) {
  const names = Object.fromEntries(
    fields.map((field, index) => [`#f${index}`, field]),
  );
  return {
    ProjectionExpression: Object.keys(names).join(", "),
    ExpressionAttributeNames: names,
  };
}
async function historyRead(client, m, key, fields) {
  const response = await client.send(
    new GetItemCommand({
      TableName: m.resources.tables.meetingHistory,
      Key: marshall(key),
      ConsistentRead: true,
      ...projection(fields),
    }),
  );
  if (!response.Item) refuse();
  return unmarshall(response.Item);
}
async function ownerSource(
  m,
  index,
  grant,
  readers,
  fixtureAuthority,
  control,
  definition,
) {
  const types = require("../../dist/types/deploymentControl.js");
  const runtime = types.runtimeRecordSchema.parse(
    await readers.read({
      pk: "ENV",
      sk: `RUNTIME#${grant.ownership.ownerInstanceId}`,
    }),
  );
  const expected =
    index === 0
      ? fixtureAuthority.priorMember
      : Object.values(control.servingMembers)[0];
  if (
    !expected ||
    !isDeepStrictEqual(runtime.identity, expected) ||
    runtime.identity.kind !== "ecs"
  )
    refuse();
  const slot = candidateSlot(
    m,
    index === 1
      ? "handoff"
      : fixtureAuthority.priorEpoch === 1
        ? "bootstrap"
        : "replacement",
  );
  const response = await readers.aws("ecs", "describe-tasks", {
    cluster: m.runtime.clusterArn,
    tasks: [runtime.identity.taskArn],
  });
  validateOwnerTask(m, slot, runtime, response);
  const source = await definition(slot.definition);
  return {
    runtime,
    transcriptionPromptName: transcriptionTemplateName(m, source),
  };
}
function transcriptionTemplateName(m, source) {
  const configuration = source.containerDefinitions.find(
    (c) => c.name === m.runtime.container,
  );
  const names = configuration.environment.filter(
    (e) => e.name === "LANGFUSE_PROMPT_TRANSCRIPTION",
  );
  if (
    names.length > 1 ||
    configuration.secrets?.some(
      (e) => e.name === "LANGFUSE_PROMPT_TRANSCRIPTION",
    )
  )
    refuse();
  return (
    names[0]?.value ||
    require("../../dist/services/langfuseDefaults.js")
      .DEFAULT_TRANSCRIPTION_PROMPT_NAME
  );
}
function validateOwnerTask(m, slot, runtime, response) {
  if (response.failures?.length || response.tasks?.length !== 1) refuse();
  const task = response.tasks[0],
    container = task.containers?.find((c) => c.name === m.runtime.container);
  if (
    task.taskArn !== runtime.identity.taskArn ||
    task.taskDefinitionArn !== slot.definition ||
    runtime.identity.candidateId !== slot.candidateId ||
    runtime.identity.imageDigest !== slot.digest ||
    container?.imageDigest !== slot.digest ||
    task.overrides?.some(
      (o) =>
        o.environmentNames?.includes("BOT_INSTANCE_ID") ||
        o.environmentFiles?.length ||
        o.commandLength > 0,
    )
  )
    refuse();
}
function validateObjectMetadata(m, response, reference, versionId) {
  if (
    response.ContentLength !== reference.byteLength ||
    response.VersionId !== versionId ||
    !versionId ||
    versionId === "null" ||
    response.ServerSideEncryption !== "aws:kms" ||
    response.SSEKMSKeyId !== m.acceptance.storageKeyArn ||
    response.BucketKeyEnabled !== false
  )
    refuse();
}
async function fixtureSession(binding, index, metadata, deadline) {
  const m = binding.manifest,
    capture = metadata.history.checkpoint.capture;
  current(binding, deadline);
  const request = contentSessionRequest(
    m,
    index,
    capture.reservedAt,
    capture.ownerInstanceId,
    now(),
  );
  const response = await awsCli("sts", "assume-role", request, {
    region: m.identity.region,
    maxAttempts: 1,
  });
  current(binding, deadline);
  const session = validateContentSession(
    m,
    index,
    capture.reservedAt,
    capture.ownerInstanceId,
    request,
    response,
    now(),
  );
  const credentials = {
    accessKeyId: response.Credentials.AccessKeyId,
    secretAccessKey: response.Credentials.SecretAccessKey,
    sessionToken: response.Credentials.SessionToken,
  };
  const { stdout } = await exec(
    "aws",
    [
      "sts",
      "get-caller-identity",
      "--region",
      m.identity.region,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    {
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        AWS_SESSION_TOKEN: credentials.sessionToken,
        AWS_MAX_ATTEMPTS: "1",
      },
      timeout: 30000,
      maxBuffer: 4096,
    },
  );
  const actual = JSON.parse(stdout);
  if (actual.Account !== m.identity.accountId || actual.Arn !== session.arn)
    refuse();
  const assertCurrent = () =>
    current(binding, Math.min(deadline, session.expiresAt));
  assertCurrent();
  const s3 = new S3Client({
    region: m.identity.region,
    credentials,
    maxAttempts: 1,
  });
  const folder = fixtureFolder(m, index, capture.reservedAt);
  const attempt = `${folder}checkpoints/v1/1-${capture.ownerInstanceId}/`;
  let totalBytes = 0;
  async function readObject(reference, kind, pinnedVersion) {
    assertCurrent();
    if (
      !Number.isSafeInteger(reference.byteLength) ||
      reference.byteLength < 1 ||
      reference.byteLength > MAX_OBJECT_BYTES ||
      totalBytes + reference.byteLength > MAX_FIXTURE_BYTES ||
      (kind === "transcript"
        ? reference.key !== `${folder}transcript.json`
        : !reference.key.startsWith(`${attempt}${kind}/`))
    )
      refuse();
    const input = {
      Bucket: m.resources.bucket,
      Key: reference.key,
      ExpectedBucketOwner: m.identity.accountId,
    };
    const head = await s3.send(
      new HeadObjectCommand({
        ...input,
        ...(pinnedVersion ? { VersionId: pinnedVersion } : {}),
      }),
    );
    assertCurrent();
    const versionId = pinnedVersion ?? head.VersionId;
    validateObjectMetadata(m, head, reference, versionId);
    const object = await s3.send(
      new GetObjectCommand({ ...input, VersionId: versionId }),
    );
    assertCurrent();
    try {
      validateObjectMetadata(m, object, reference, versionId);
      if (!object.Body) refuse();
      const chunks = [];
      let bytesRead = 0;
      for await (const chunk of object.Body) {
        assertCurrent();
        bytesRead += chunk.length;
        if (bytesRead > reference.byteLength) refuse();
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      if (
        bytes.length !== reference.byteLength ||
        checksum(bytes) !== reference.checksumSha256
      )
        refuse();
      totalBytes += bytes.length;
      return { bytes, reference: { ...reference, versionId } };
    } finally {
      object.Body?.destroy();
    }
  }
  return { readObject, assertCurrent, folder, attempt };
}
function validateFixtureReferences(m, index, metadata, review) {
  const { history } = metadata,
    capture = history.checkpoint.capture;
  const folder = fixtureFolder(m, index, capture.reservedAt);
  const attempt = `${folder}checkpoints/v1/1-${capture.ownerInstanceId}/`;
  const { acknowledgment, ...transcript } = history.fixtureTranscript;
  const { versionId, ...manifest } = review.manifest;
  if (
    history.checkpoint.artifactFolder !== folder ||
    history.checkpoint.manifest.key !==
      `${attempt}manifests/${history.checkpoint.revision}-${history.checkpoint.manifest.checksumSha256}.json` ||
    transcript.key !== `${folder}transcript.json` ||
    !isDeepStrictEqual(manifest, history.checkpoint.manifest) ||
    !isDeepStrictEqual(review.transcript, {
      ...transcript,
      versionId: acknowledgment.versionId,
    }) ||
    !versionId ||
    versionId === "null" ||
    [manifest, transcript].some(
      (ref) => ref.byteLength < 1 || ref.byteLength > MAX_OBJECT_BYTES,
    )
  )
    refuse();
}
async function collectContents(
  binding,
  index,
  metadata,
  review,
  client,
  deadline,
) {
  const { history } = metadata,
    m = binding.manifest;
  const session = await fixtureSession(binding, index, metadata, deadline);
  const manifestObject = await session.readObject(
    history.checkpoint.manifest,
    "manifests",
    review.manifest.versionId,
  );
  if (!isDeepStrictEqual(manifestObject.reference, review.manifest)) refuse();
  const manifest =
    require("../../dist/services/productionFixtureCapture.js").inspectFixtureManifest(
      { metadata, manifest: JSON.parse(manifestObject.bytes.toString("utf8")) },
    );
  const audio = new Map();
  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "audio") continue;
    audio.set(
      artifact.object.key,
      (await session.readObject(artifact.object, "audio")).bytes,
    );
  }
  const transcript = await session.readObject(
    history.fixtureTranscript,
    "transcript",
    history.fixtureTranscript.acknowledgment.versionId,
  );
  const { acknowledgment, ...transcriptReference } = transcript.reference;
  if (!isDeepStrictEqual(transcriptReference, review.transcript)) refuse();
  await verifyNotes(client, m, metadata, review, session);
  const capture =
    require("../../dist/services/productionFixtureCapture.js").inspectFixtureSavedAudio(
      { metadata, manifest, audio, acrossHandoff: index === 0 },
    );
  return { manifest, audio, capture, historicalHandoff: "unverified" };
}
async function verifyNotes(client, m, { history, grant }, review, session) {
  session.assertCurrent();
  const notes = await historyRead(client, m, grant.historyKey, [
    "notes",
    ...Object.keys(history),
  ]);
  session.assertCurrent();
  const { notes: text, ...reread } = notes;
  if (!isDeepStrictEqual(reread, history) || typeof text !== "string") refuse();
  const bytes = Buffer.from(text, "utf8");
  if (
    bytes.length < 1 ||
    bytes.length > 256 * 1024 ||
    review.notes.byteLength !== bytes.length ||
    review.notes.checksumSha256 !== checksum(bytes) ||
    review.notes.version !== history.notesVersion ||
    review.notes.channelId !== history.notesChannelId ||
    !isDeepStrictEqual(review.notes.messageIds, history.notesMessageIds)
  )
    refuse();
}
function validateCollectionHold(binding, hold) {
  const m = binding.manifest;
  if (
    hold.holdId !== m.holdId ||
    hold.introductionId !== m.introductionId ||
    hold.manifestHash !== binding.manifestHash ||
    hold.revision !== 1 ||
    hold.admission.state !== "held" ||
    hold.deployment.state !== "held"
  )
    refuse();
}
async function readCollectionState(binding, readers) {
  const m = binding.manifest;
  const builders = require("../../dist/services/productionIntroductionTransactions.js");
  const types = require("../../dist/types/deploymentControl.js");
  const hold = builders.introductionHoldSchema.parse(
    await readers.read({ pk: "ENV", sk: "INTRODUCTION" }),
  );
  const control = types.controlRecordSchema.parse(
    await readers.read({ pk: "ENV", sk: "CONTROL" }),
  );
  const fixtureAuthority = builders.fixtureCoordinatorAuthoritySchema.parse(
    await readers.read({
      pk: `INTRODUCTION#${m.introductionId}`,
      sk: "FIXTURE_COORDINATOR",
    }),
  );
  validateCollectionHold(binding, hold);
  if (
    !isDeepStrictEqual(control.maintenance, {
      holdId: m.holdId,
      introductionId: m.introductionId,
      revision: 1,
    }) ||
    fixtureAuthority.manifestHash !== binding.manifestHash ||
    fixtureAuthority.holdId !== m.holdId ||
    fixtureAuthority.introductionId !== m.introductionId ||
    fixtureAuthority.runToken !== m.handoff.runToken ||
    control.coordinatorToken !== m.handoff.runToken ||
    control.deployment?.phase !== "complete" ||
    Object.keys(control.servingMembers).length !== 1
  )
    refuse();
  return { hold, control, fixtureAuthority };
}
async function collectGeneratedFixtures() {
  const loaded = await loadAcceptancePackage();
  const binding = loaded.collection
    ? readCollectionBinding(loaded.collection)
    : loaded.binding;
  const m = binding.manifest,
    deadline = loaded.collection ? m.acceptance.prepareDeadline : m.validUntil;
  current(binding, deadline);
  const readers = loaded.collection
    ? createAcceptanceReadAws(loaded.collection)
    : createProductionAws(binding);
  const sourceRoutes = require("./production-source-routes.cjs");
  const sourceReceipt = sourceRoutes.verifyDeclaredRoutes(binding);
  await verifyOwnershipEvidence(binding, loaded.evidence, process.env.GH_TOKEN);
  const inventory = createInventoryReader(m, readers.aws);
  await createCandidateInspection({
    binding,
    ...readers,
    definition: inventory.definition,
    now,
  }).definitions();
  const pinned = await readPinnedSupplement(
    binding,
    process.env,
    process.env.GITHUB_JOB,
  );
  const supplement = verifySupplement(
    pinned.value,
    binding,
    loaded.acceptanceContext?.approvedReviewerIds,
    now(),
  );
  const { hold, control, fixtureAuthority } = await readCollectionState(
    binding,
    readers,
  );
  const client = new DynamoDBClient({ region: m.identity.region });
  const validator = require("../../dist/services/productionFixtureAcceptance.js");
  const fixtures = [];
  // Both metadata/source gates complete before any generated content or narrowed session.
  for (const [index, expected] of m.handoff.grants.entries()) {
    const grant = exactGrant(
      m,
      index,
      await readers.read({
        pk: `FIXTURE#${expected.grantId}`,
        sk: "AUTHORITY",
      }),
    );
    const source = await ownerSource(
      m,
      index,
      grant,
      readers,
      fixtureAuthority,
      control,
      inventory.definition,
    );
    const history = await historyRead(
      client,
      m,
      grant.historyKey,
      Object.keys(validator.fixtureHistoryMetadataSchema.shape),
    );
    const metadata = validator.inspectFixtureMetadata({
      grant,
      history,
      validFrom: m.validFrom,
      now: now(),
    });
    const fallbackPaths = validator.inspectFixtureFallbacks(
      history.fixtureGeneration,
      source.transcriptionPromptName,
    );
    const review = supplement.fixtures[index];
    if (
      review.ownerInstanceId !== grant.ownership.ownerInstanceId ||
      review.voiceOperationAttemptId !==
        grant.ownership.voiceOperationAttemptId ||
      !isDeepStrictEqual(review.historyKey, grant.historyKey)
    )
      refuse();
    validateFixtureReferences(m, index, metadata, review);
    fixtures.push({
      metadata,
      runtime: source.runtime,
      fallbackSource: sourceRoutes.readVerifiedFallbackTemplates(
        sourceReceipt,
        binding.manifestHash,
        fallbackPaths,
      ),
    });
  }
  current(binding, deadline);
  for (const [index, fixture] of fixtures.entries())
    fixture.contents = await collectContents(
      binding,
      index,
      fixture.metadata,
      supplement.fixtures[index],
      client,
      deadline,
    );
  current(binding, deadline);
  const token = Object.freeze({});
  collections.set(token, {
    binding,
    hold,
    control,
    fixtureAuthority,
    fixtures,
    pinned,
    supplement,
    deadline,
  });
  return token;
}
async function collectGeneratedFixturesFromOriginalRun() {
  try {
    return await collectGeneratedFixtures();
  } catch {
    return refuse();
  }
}
function readGeneratedFixtures(token) {
  const value = collections.get(token);
  if (!value) refuse();
  current(value.binding, value.deadline);
  return structuredClone(value);
}
module.exports = {
  collectGeneratedFixturesFromOriginalRun,
  readGeneratedFixtures,
};
