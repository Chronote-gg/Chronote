import {
  collectorTemplateSha256,
  captureNamespace,
} from "../../../scripts/deployment/collector-command.cjs";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { manifestHash } from "../../../scripts/deployment/sandbox-manifest.cjs";
import { buildMaintenancePolicy } from "../../../scripts/deployment/maintenance-fence.cjs";
export function manifestFixture() {
  const accountId = "123456789012",
    region = "us-east-1";
  const ecs = `arn:aws:ecs:${region}:${accountId}:`;
  const elb = `arn:aws:elasticloadbalancing:${region}:${accountId}:`;
  const table = `arn:aws:dynamodb:${region}:${accountId}:table/chronote-`;
  const binding = {
    accountId,
    region,
    taskRoleArn: `arn:aws:iam::${accountId}:role/chronote-app`,
    operationId: randomUUID(),
    activeMeetingTableArn: table + "ActiveMeetingTable",
    personalMediaUploadJobTableArn: table + "PersonalMediaUploadJobTable",
    sourceSha: "a".repeat(40),
    legacySha: "b".repeat(40),
    candidateDigest: "sha256:" + "c".repeat(64),
    tableArns: {
      leases: table + "ActiveMeetingTable",
      history: table + "MeetingHistoryTable",
      controls: table + "MeetingControlCommandTable",
      uploads: table + "PersonalMediaUploadJobTable",
      segments: table + "PersonalRecordingSegmentTable",
      billing: table + "GuildSubscriptionTable",
      webhooks: table + "StripeWebhookEventTable",
      payments: table + "PaymentTransactionTable",
    },
  };
  return {
    kind: "production-introduction",
    environment: "production",
    binding,
    deploymentRoleArn: `arn:aws:iam::${accountId}:role/chronote-github-deploy`,
    executionRoleArn: `arn:aws:iam::${accountId}:role/chronote-execution`,
    sourceRepository: "Chronote-gg/Chronote",
    imageRepository: "chronote-bot-repo",
    cluster: "chronote-cluster",
    service: "chronote-service",
    containerName: "chronote-bot",
    containerPort: 3001,
    runtimeMode: "all",
    bucket: "chronote-transcripts",
    tablePrefix: "chronote-",
    controlTableArn: table + "DeploymentControlTable",
    legacyTaskArn: ecs + "task/chronote-cluster/" + "d".repeat(32),
    legacyTaskDefinition: ecs + "task-definition/chronote-bot:1",
    taskDefinition: ecs + "task-definition/chronote-bot:2",
    fallbackTaskDefinition: ecs + "task-definition/chronote-bot:3",
    fallbackSourceSha: "9".repeat(40),
    fallbackDigest: "sha256:" + "8".repeat(64),
    targetDeploymentConfiguration: {
      minimumHealthyPercent: 100,
      maximumPercent: 200,
      strategy: "ROLLING",
      earlySuccessCriteria: {
        enable: true,
        healthyPercent: 100,
        sourceServiceRevisionCleanup: "DEFERRED",
      },
      deploymentCircuitBreaker: { enable: true, rollback: false },
    },
    listenerArn: elb + "listener/app/chronote/1/2",
    targetGroupA: elb + "targetgroup/chronote-a/1",
    targetGroupB: elb + "targetgroup/chronote-b/2",
    ownedPolicyName: "chronote-maintenance-" + binding.operationId,
    ownedPolicySha256: manifestHash(buildMaintenancePolicy(binding)),
    originalPolicySha256: "e".repeat(64),
    originalControllerSha256: "f".repeat(64),
    targetControllerSha256: "7".repeat(64),
    knownWriterSha256: "1".repeat(64),
    collectorCommandTemplateSha256: collectorTemplateSha256(),
    originalServiceSha256: "3".repeat(64),
    originalRoutingSha256: "4".repeat(64),
    evidenceStoreId: "approved-private-fixture",
    validUntil: 5000,
    observationMaxAgeSeconds: 60,
    drainDeadline: 4000,
    warmupDeadline: 4500,
    maxPages: 10,
    maxRows: 100,
    pageSize: 10,
  };
}

export function evidenceFixture(m = manifestFixture()) {
  const calls = [],
    proofs = [];
  const probe = async (request) => {
    calls.push("collect");
    const proof = {
      request,
      compatibilityTarget: request.compatibilityTarget,
      observedAt: 1000,
      validUntil: 1050,
      owners: ["legacy"],
      tasks: [
        {
          taskArn: m.legacyTaskArn,
          taskDefinitionArn: m.legacyTaskDefinition,
          sourceSha: m.binding.legacySha,
          lastStatus: "RUNNING",
        },
      ],
      policies: {
        unrelatedSha256: m.originalPolicySha256,
        ownedSha256: m.ownedPolicySha256,
      },
      controllers: [],
      controllerSha256:
        request.taskDefinition === m.legacyTaskDefinition
          ? m.originalControllerSha256
          : m.targetControllerSha256,
      knownWriterSha256: m.knownWriterSha256,
      freezeEvidenceSha256: "5".repeat(64),
      effectsEvidenceSha256: "6".repeat(64),
      complete: {
        tasks: true,
        owners: true,
        policies: true,
        controllers: true,
        knownWriters: true,
      },
      probes: {
        meetingAcquire: "iam_denied",
        uploadClaim: "iam_denied",
        uploadRenew: "condition_refused",
        uploadProgress: "condition_refused",
        meetingRelease: "condition_refused",
        meetingRenew: "condition_refused",
      },
      settlements: [],
      compatibility: { binding: m.binding, uploads: [] },
    };
    proofs.push(proof);
    return proof;
  };
  const captures = new Map();
  probe.capture = async (value) => {
    const body = JSON.stringify(value),
      sha256 = manifestHash(value),
      namespace = captureNamespace(m, manifestHash(m));
    captures.set(sha256, JSON.parse(body));
    return {
      storeId: m.evidenceStoreId,
      namespace,
      key: sha256,
      sha256,
      size: Buffer.byteLength(body),
    };
  };
  probe.readCapture = async (reference) => captures.get(reference.key);
  const aws = async () => {
    calls.push("scan");
    return { Items: [] };
  };
  const options = {
    m,
    aws,
    probe,
    now: () => 1000,
    manifestSha256: manifestHash(m),
  };
  return { m, calls, proofs, options };
}

export function phaseAuthorization(
  m,
  phase,
  predecessorSha256 = null,
  runId = "123",
) {
  const envelope = {
    kind: "production-phase",
    manifestSha256: manifestHash(m),
    operationId: m.binding.operationId,
    phase,
    runId,
    runAttempt: 1,
    principalArn: `arn:aws:sts::${m.binding.accountId}:assumed-role/chronote-github-deploy/chronote-production-${runId}-1`,
    sourceSha: m.binding.sourceSha,
    predecessorSha256,
    validUntil: 2000,
    recovery: null,
  };
  return {
    envelope,
    expectedSha256: manifestHash(envelope),
    bindSha256: manifestHash(envelope),
    currentRunId: runId,
    currentRunAttempt: 1,
  };
}

export function introductionFixture(
  marshall,
  unmarshall,
  stateDigest,
  manifest,
) {
  const f = evidenceFixture(manifest),
    m = f.m,
    rows = new Map(),
    writes = [];
  let owned = false,
    clock = 1000,
    principal = phaseAuthorization(m, "fence").envelope.principalArn;
  const svc = {
    serviceName: m.service,
    deploymentController: { type: "ECS" },
    deploymentConfiguration: m.targetDeploymentConfiguration,
    taskDefinition: m.legacyTaskDefinition,
    desiredCount: 1,
    runningCount: 1,
    pendingCount: 0,
    loadBalancers: [
      {
        targetGroupArn: m.targetGroupA,
        containerName: m.containerName,
        containerPort: m.containerPort,
      },
    ],
  };
  m.originalServiceSha256 = stateDigest(svc);
  const legacy = {
    taskArn: m.legacyTaskArn,
    taskDefinitionArn: m.legacyTaskDefinition,
    lastStatus: "RUNNING",
  };
  const originalProbe = f.options.probe;
  const probe = async (request) => {
    const proof = await originalProbe(request);
    proof.policies.ownedSha256 = owned ? m.ownedPolicySha256 : null;
    proof.probes.meetingAcquire = proof.probes.uploadClaim = owned
      ? "iam_denied"
      : "condition_refused";
    proof.tasks[0].lastStatus = legacy.lastStatus;
    if (legacy.lastStatus === "STOPPED") {
      proof.owners = [];
      proof.probes = null;
    }
    return proof;
  };
  probe.capture = originalProbe.capture;
  probe.readCapture = originalProbe.readCapture;
  function transact(service, operation, input) {
    writes.push([service, operation, input]);
    for (const entry of input.TransactItems)
      if (entry.Put) {
        const row = unmarshall(entry.Put.Item),
          old = rows.get(row.sk);
        if (entry.Put.ConditionExpression === "attribute_not_exists(pk)" && old)
          throw new Error("Condition failed");
      }
    for (const entry of input.TransactItems)
      if (entry.Put) rows.set(unmarshall(entry.Put.Item).sk, entry.Put.Item);
    return {};
  }
  const aws = async (service, operation, input) => {
    if (service === "sts")
      return { Account: m.binding.accountId, Arn: principal };
    if (operation === "get-item")
      return { Item: rows.get(unmarshall(input.Key).sk) };
    if (operation === "scan") return { Items: [] };
    if (operation === "transact-write-items")
      return transact(service, operation, input);
    if (operation === "describe-services")
      return { services: [JSON.parse(JSON.stringify(svc))] };
    if (operation === "list-tasks")
      return {
        taskArns: input.desiredStatus === "RUNNING" ? [m.legacyTaskArn] : [],
      };
    if (operation === "describe-tasks")
      return { tasks: [JSON.parse(JSON.stringify(legacy))] };
    if (operation === "describe-task-definition")
      return {
        taskDefinition: {
          taskDefinitionArn: m.taskDefinition,
          status: "ACTIVE",
          taskRoleArn: m.binding.taskRoleArn,
          executionRoleArn: m.executionRoleArn,
          containerDefinitions: [
            {
              name: m.containerName,
              image: `${m.binding.accountId}.dkr.ecr.${m.binding.region}.amazonaws.com/${m.imageRepository}@${m.binding.candidateDigest}`,
              stopTimeout: 120,
              command: ["node", "dist/index.js"],
              environment: [
                { name: "TRANSCRIPTS_BUCKET", value: m.bucket },
                { name: "DDB_TABLE_PREFIX", value: m.tablePrefix },
                {
                  name: "DEPLOYMENT_CANDIDATE_ID",
                  value: m.binding.operationId,
                },
                ...[
                  "STRIPE_SUBSCRIPTION_TRANSITIONS_ENABLED",
                  "STRIPE_RENEWAL_GRACE_ENABLED",
                  "STRIPE_INTRO_OFFER_LEDGER_ENABLED",
                  "STRIPE_RENEWAL_REACTIVATION_ENABLED",
                ].map((name) => ({ name, value: "false" })),
              ],
            },
          ],
        },
      };
    if (operation === "describe-images")
      return { imageDetails: [{ imageDigest: m.binding.candidateDigest }] };
    if (operation === "put-role-policy") {
      owned = true;
      writes.push([service, operation, input]);
      return {};
    }
    if (operation === "delete-role-policy") {
      owned = false;
      writes.push([service, operation, input]);
      return {};
    }
    throw new Error("Unexpected operation " + operation);
  };
  const options = {
    manifest: m,
    expectedSha256: manifestHash(m),
    aws,
    probe,
    now: () => clock,
  };
  function authorize(phase, runId = "123") {
    const head = rows.get("PRODUCTION_INTRODUCTION");
    options.authorization = phaseAuthorization(
      m,
      phase,
      head ? unmarshall(head).receiptSha256 : null,
      runId,
    );
    principal = options.authorization.envelope.principalArn;
  }
  authorize("fence");
  return {
    ...f,
    options,
    rows,
    writes,
    svc,
    legacy,
    authorize,
    isOwned: () => owned,
    setClock: (value) => {
      clock = value;
    },
  };
}
