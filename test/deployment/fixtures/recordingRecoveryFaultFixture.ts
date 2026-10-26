import { createHash, randomUUID } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { createDynamoDeploymentControlRepository } from "../../../src/repositories/deploymentControlRepository";
import { createRecordingCheckpointService } from "../../../src/services/recordingCheckpointService";
import { recoveryFixture } from "../../services/meetingRecoveryFixtures";
import { control, runtime, history, context } from "../controlFixtures";
import type {
  CheckpointArtifactInput,
  RecordingCaptureState,
} from "../../../src/types/recordingCheckpoint";
import type { RecoveryDependencies } from "../../../src/services/meetingRecoveryService";
import { recoverTranscript } from "../../../src/services/meetingRecoveryContent";

export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

export function createRecoveryFaultDatabase(names?: {
  deploymentControl: string;
  meetingHistory: string;
  activeMeeting: string;
}) {
  const prefix = `recovery-fault-${randomUUID()}-`;
  const tables = names ?? {
    deploymentControl: `${prefix}Control`,
    meetingHistory: `${prefix}History`,
    activeMeeting: `${prefix}Lease`,
  };
  const client = new DynamoDBClient({
    endpoint: process.env.DEPLOYMENT_TEST_DYNAMODB_ENDPOINT,
    region: "local",
    credentials: { accessKeyId: "dummy", secretAccessKey: "dummy" },
    maxAttempts: 1,
  });
  const repository = createDynamoDeploymentControlRepository(client, tables);
  const created: string[] = [];
  async function put(table: string, item: object) {
    await client.send(
      new PutItemCommand({
        TableName: table,
        Item: marshall(item, { removeUndefinedValues: true }),
      }),
    );
  }
  return {
    tables,
    client,
    repository,
    put,
    async start() {
      for (const [name, keys] of [
        [tables.deploymentControl, ["pk", "sk"]],
        [tables.meetingHistory, ["guildId", "channelId_timestamp"]],
        [tables.activeMeeting, ["guildId"]],
      ] as const) {
        await client.send(
          new CreateTableCommand({
            TableName: name,
            BillingMode: "PAY_PER_REQUEST",
            KeySchema: keys.map((AttributeName, index) => ({
              AttributeName,
              KeyType: index === 0 ? "HASH" : "RANGE",
            })),
            AttributeDefinitions: keys.map((AttributeName) => ({
              AttributeName,
              AttributeType: "S",
            })),
          }),
        );
        created.push(name);
      }
    },
    async close() {
      for (const TableName of created)
        await client.send(new DeleteTableCommand({ TableName }));
      client.destroy();
    },
  };
}

export async function recoveryFaultFixture(
  db: ReturnType<typeof createRecoveryFaultDatabase>,
  options: Parameters<typeof recoveryFixture>[1] = {},
) {
  // This template supplies generated content only. The tested producer publishes it
  // again through the real object-before-manifest and Dynamo transaction paths.
  const template = await recoveryFixture(undefined, options);
  const original = template.claim.history.checkpoint!;
  const verified = await template.reader.read(original);
  const artifacts: CheckpointArtifactInput[] = verified.manifest.artifacts.map(
    (artifact) => ({
      ...artifact,
      bytes: template.objects.get(artifact.object.key)!,
      checksumSha256: artifact.object.checksumSha256,
    }),
  );
  const objects = new Map<string, Buffer>();
  const upload = jest.fn(async (key: string, bytes: string | Uint8Array) => {
    if (!objects.has(key)) objects.set(key, Buffer.from(bytes));
    return key;
  });
  const read = jest.fn(async (key: string) => objects.get(key));
  const reader = createRecordingCheckpointService({
    repository: db.repository,
    objects: { upload, read },
  });
  const now = Math.floor(Date.now() / 1000);
  const row = { ...history, textChannelId: "text", ...options.requested };
  const ownership = {
    guildId: row.guildId,
    meetingId: row.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "original-voice",
    sessionMode: "meeting" as const,
  };
  const lease = {
    ...ownership,
    voiceChannelId: row.channelId,
    textChannelId: "text",
    isAutoRecording: false,
    createdAt: row.timestamp,
    updatedAt: row.timestamp,
    leaseExpiresAt: now + 600,
    expiresAt: now + 720,
  };
  await db.put(db.tables.meetingHistory, row);
  await db.put(db.tables.activeMeeting, lease);
  await db.put(db.tables.deploymentControl, {
    ...control,
    coordinatorExpiresAt: now + 600,
  });
  const member = runtime("old");
  member.readiness!.expiresAt = now + 600;
  member.protection!.expiresAt = now + 600;
  await db.put(db.tables.deploymentControl, member);
  const input = {
    ownership,
    capture: original.capture,
    captureState: {
      kind: "capturing",
      startedAt: row.timestamp,
    } satisfies RecordingCaptureState,
    expectedStatus: "starting" as const,
    previous: undefined,
    artifacts,
    signal: new AbortController().signal,
  };
  let sent = 0;
  const send = jest.fn(async () => ({ id: `generated-message-${++sent}` }));
  const notes = jest.fn<
    ReturnType<RecoveryDependencies["notes"]>,
    Parameters<RecoveryDependencies["notes"]>
  >(async (input) => {
    input.processing = { ...input.processing, notes: "generated" };
    input.notesText = "Generated saved decision.";
    return input.notesText;
  });
  const summaries: RecoveryDependencies["summaries"] = async (input) => {
    input.processing = { ...input.processing, summary: "generated" };
    input.summarySentence = "Generated summary.";
    return { summarySentence: input.summarySentence };
  };
  const autoExport = jest.fn(async (): Promise<"skipped"> => "skipped");
  const deps: RecoveryDependencies = {
    repository: db.repository,
    reader,
    signal: new AbortController().signal,
    now: () => now,
    nowMs: () => now * 1000,
    effect: (run) => run(),
    notes,
    summaries,
    transcript: recoverTranscript,
    upload,
    send,
    autoExport,
  };
  const readHistory = async () => {
    const saved = await db.repository.getMeetingHistory({
      guildId: row.guildId,
      channelId_timestamp: row.channelId_timestamp,
    });
    if (!saved) throw new Error("Generated history missing");
    return saved;
  };
  async function optionalClaim() {
    const expired = { ...lease, leaseExpiresAt: now - 1 };
    await db.put(db.tables.activeMeeting, expired);
    const claimed = await db.repository.claimRecordingRecovery({
      history: await readHistory(),
      lease: expired,
      context: { ...context, now },
      attemptId: randomUUID(),
    });
    return claimed;
  }
  return {
    ...db,
    reader,
    objects,
    upload,
    read,
    input,
    row,
    ownership,
    lease,
    now,
    deps,
    send,
    notes,
    autoExport,
    readHistory,
    optionalClaim,
    claim: async () => {
      const result = await optionalClaim();
      if (!result) throw new Error("Generated recovery claim refused");
      return result;
    },
  };
}

export function generatedAudio(): CheckpointArtifactInput {
  const bytes = Buffer.alloc(48000 * 4, 1);
  return {
    kind: "audio",
    sourceId: "user:123",
    sequence: 0,
    contentType: "application/octet-stream",
    format: { encoding: "pcm_s16le", sampleRate: 48000, channels: 2 },
    coverage: {
      kind: "known",
      intervals: [{ sourceId: "user:123", startOffsetMs: 0, durationMs: 1000 }],
    },
    bytes,
    checksumSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function startCompatibleRecoveryRuntime(
  f: Awaited<ReturnType<typeof recoveryFaultFixture>>,
) {
  const lifecycleModule =
    await import("../../../src/services/runtimeLifecycleService");
  const { createRuntimeProtectionService } =
    await import("../../../src/services/runtimeProtectionService");
  const old = runtime("old");
  old.readiness!.expiresAt = f.now - 1;
  old.protection!.expiresAt = f.now + 600;
  old.workCounts = {
    recording: 1,
    voice_operation: 1,
    finalization: 0,
    recovery_processing: 0,
    personal_processing: 0,
    ancillary_delivery: 0,
    pending_admission: 0,
  };
  const selected = runtime("replacement");
  if (selected.identity.kind !== "ecs" || old.identity.kind !== "ecs")
    throw new Error("Generated ECS identity required");
  selected.identity.candidateId = old.identity.candidateId;
  const selectedIdentity = selected.identity;
  const current = {
    ...control,
    coordinatorExpiresAt: f.now - 1,
    deployment: {
      runToken: "generated-completed-rollout",
      cluster: "fixture",
      service: "fixture",
      family: "fixture",
      tablePrefix: "fixture",
      candidateId: "old",
      image: "fixture",
      runtimeMode: "all" as const,
      phase: "complete" as const,
      originalGeneration: 6,
      originalMembers: [runtime("previous").identity],
      outgoing: runtime("previous").identity,
      previousTaskDefinition: "fixture:1",
      taskDefinition: "fixture:2",
      candidate: old.identity,
      updatedAt: f.now - 10,
    },
  };
  const voice = {
    pk: `VOICE#${f.row.guildId}`,
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: f.row.guildId,
    meetingId: f.row.meetingId,
    ownerInstanceId: "old",
    attemptId: "original-voice",
    state: "uncertain",
    updatedAt: f.now,
  };
  await f.put(f.tables.deploymentControl, old);
  await f.put(f.tables.deploymentControl, current);
  await f.put(f.tables.deploymentControl, voice);
  await f.put(f.tables.activeMeeting, {
    ...f.lease,
    leaseExpiresAt: f.now - 1,
  });
  const protection = createRuntimeProtectionService({
    identity: selectedIdentity,
    agentUri: "http://fixture.invalid",
    now: () => Math.floor(Date.now() / 1000),
    onUnsafe: () => {},
    request: async () =>
      new Response(
        JSON.stringify({
          protection: {
            TaskArn: selectedIdentity.taskArn,
            ProtectionEnabled: true,
            ExpirationDate: new Date((f.now + 600) * 1000).toISOString(),
          },
        }),
      ),
  });
  const lifecycle = lifecycleModule.createRuntimeLifecycle({
    identity: selectedIdentity,
    repository: f.repository,
    protection,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  lifecycleModule.installRuntimeLifecycle(lifecycle);
  await lifecycle.start();
  const admission = await lifecycle.getRuntimeAdmissionContext();
  if (!lifecycle.isAcceptingWork())
    throw new Error("Compatible replacement did not enter serving");
  return {
    lifecycle,
    voice,
    old: await f.repository.getRecord("ENV", "RUNTIME#old"),
    admission,
  };
}
