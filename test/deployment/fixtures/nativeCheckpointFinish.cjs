// Compiled application code, real DynamoDB transactions and S3 HTTP, generated data only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { setTimeout: delay } = require("node:timers/promises");
const {
  DynamoDBClient,
  CreateTableCommand,
  PutItemCommand,
  ListTablesCommand,
} = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const {
  S3Client,
  CreateBucketCommand,
  ListBucketsCommand,
} = require("@aws-sdk/client-s3");
const {
  createDynamoMeetingHistoryTransitionRepository,
} = require("./dist/repositories/meetingHistoryTransitions");
const {
  createRecordingCheckpointService,
} = require("./dist/services/recordingCheckpointService");
const {
  createRecordingCheckpointCapture,
} = require("./dist/services/recordingCheckpointCapture");
const {
  uploadObjectToS3,
  fetchObjectBytesFromS3,
} = require("./dist/services/storageService");

async function main() {
  const { history } = JSON.parse(
    Buffer.from(process.env.FINISH_FIXTURE, "base64").toString(),
  );
  const dynamo = new DynamoDBClient({
    endpoint: "http://dynamodb:8000",
    region: "us-east-1",
    maxAttempts: 1,
  });
  const s3 = new S3Client({
    endpoint: "http://minio:9000",
    region: "us-east-1",
    forcePathStyle: true,
    maxAttempts: 1,
  });
  async function ready(client, command) {
    const deadline = Date.now() + 30000;
    for (;;) {
      try {
        await client.send(command);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(250);
      }
    }
  }
  await Promise.all([
    ready(dynamo, new ListTablesCommand({})),
    ready(s3, new ListBucketsCommand({})),
  ]);
  // The checkpoint path reads only the lease and the history row; no control table is created.
  const tables = {
    deploymentControl: "finish-Control-unused",
    meetingHistory: "finish-History",
    activeMeeting: "finish-Lease",
  };
  for (const [TableName, keys] of [
    [tables.meetingHistory, ["guildId", "channelId_timestamp"]],
    [tables.activeMeeting, ["guildId"]],
  ]) {
    await dynamo.send(
      new CreateTableCommand({
        TableName,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: keys.map((AttributeName) => ({
          AttributeName,
          AttributeType: "S",
        })),
        KeySchema: keys.map((AttributeName, index) => ({
          AttributeName,
          KeyType: index ? "RANGE" : "HASH",
        })),
      }),
    );
  }
  const put = (TableName, row) =>
    dynamo.send(
      new PutItemCommand({
        TableName,
        Item: marshall(row, { removeUndefinedValues: true }),
      }),
    );
  const now = Math.floor(Date.now() / 1000);
  const repository = createDynamoMeetingHistoryTransitionRepository(
    dynamo,
    tables,
  );
  const checkpoint = createRecordingCheckpointService({
    repository,
    objects: { upload: uploadObjectToS3, read: fetchObjectBytesFromS3 },
  });
  const results = [];
  for (const succeeds of [true, false]) {
    const row = {
      ...history,
      guildId: succeeds ? "generated-retry" : "generated-exhaustion",
      status: "in_progress",
    };
    const ownership = {
      guildId: row.guildId,
      meetingId: row.meetingId,
      ownerInstanceId: "old",
      executionVersion: 1,
      voiceOperationAttemptId: "generated-voice",
      sessionMode: "meeting",
    };
    await put(tables.meetingHistory, row);
    await put(tables.activeMeeting, {
      ...ownership,
      voiceChannelId: row.channelId,
      textChannelId: "generated-text",
      isAutoRecording: false,
      createdAt: row.timestamp,
      updatedAt: row.timestamp,
      leaseExpiresAt: now + 600,
      expiresAt: now + 720,
    });
    const capture = {
      guildId: row.guildId,
      meetingId: row.meetingId,
      ownerInstanceId: ownership.ownerInstanceId,
      executionVersion: ownership.executionVersion,
      channelId: row.channelId,
      channelId_timestamp: row.channelId_timestamp,
      reservedAt: row.timestamp,
      captureStartedAt: row.timestamp,
      requested: { transcribeMeeting: true, generateNotes: true },
    };
    const directory = `/tmp/${row.guildId}`;
    const bucket = succeeds ? "generated-retry" : "generated-exhaustion";
    // The SDK sees a real NoSuchBucket response before the existing publisher retries.
    require("./dist/services/configService").config.storage.transcriptBucket =
      bucket;
    let previous;
    let attempts = 0;
    let firstResult;
    let observedFailure;
    const firstFailure = new Promise((resolve) => {
      observedFailure = resolve;
    });
    let releaseFailure;
    const failureReleased = new Promise((resolve) => {
      releaseFailure = resolve;
    });
    let stopped = false;
    let ended = false;
    const pcm = Buffer.alloc(48000 * 4 * 30, 1);
    const recording = createRecordingCheckpointCapture({
      directory,
      startedAt: Date.parse(row.timestamp),
      signal: new AbortController().signal,
      stopCapture: () => {
        stopped = true;
      },
      commit: async (artifacts, signal) => {
        attempts++;
        const result = await checkpoint.flush({
          ownership,
          capture,
          captureState: ended
            ? {
                kind: "complete",
                startedAt: row.timestamp,
                endedAt: new Date(
                  Date.parse(row.timestamp) + 30000,
                ).toISOString(),
              }
            : { kind: "capturing", startedAt: row.timestamp },
          expectedStatus: "in_progress",
          previous,
          artifacts,
          signal,
        });
        firstResult ??= result.kind;
        if (attempts === 1) {
          observedFailure();
          await failureReleased;
        }
        if (result.kind !== "committed") return false;
        previous = result.checkpoint;
        return true;
      },
    });
    assert.equal(
      recording.push("generated-source", pcm, Date.parse(row.timestamp)),
      true,
    );
    await firstFailure;
    assert.equal(firstResult, "preservation_failed");
    assert.equal(attempts, 1);
    assert.equal(fs.readdirSync(directory).length, 1);
    if (succeeds) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    // Restore storage before starting the retry clock, independent of host speed.
    releaseFailure();
    await recording.settled();
    ended = true;
    const finished = await recording.finish();
    assert.equal(finished, succeeds);
    assert.equal(attempts, 3); // retry plus terminal checkpoint, or three exhausted attempts
    const saved = await repository.getMeetingHistory({
      guildId: row.guildId,
      channelId_timestamp: row.channelId_timestamp,
    });
    if (succeeds) {
      const verified = await checkpoint.read(saved.checkpoint);
      assert.equal(verified.manifest.captureState.kind, "complete");
      assert.equal(verified.missing.length, 0);
      assert.equal(verified.manifest.artifacts.length, 1);
      assert.ok(
        pcm.equals(
          await checkpoint.readVerifiedObject(
            verified.manifest.artifacts[0].object,
          ),
        ),
      );
      assert.equal(fs.readdirSync(directory).length, 0);
      assert.equal(stopped, false);
    } else {
      assert.equal(saved.checkpoint, undefined);
      assert.deepEqual(fs.readFileSync(recording.pending()[0].file), pcm);
    }
    recording.releaseSettledBuffers();
    results.push({
      succeeds,
      finished,
      attempts,
      retainedFiles: fs.readdirSync(directory).length,
    });
  }
  dynamo.destroy();
  s3.destroy();
  console.log(
    "CHECKPOINT_FINISH_RESULT=" +
      JSON.stringify({
        results,
        mockedApplicationModules: 0,
        discordVoiceAcceptance: "NOT_TESTED",
      }),
  );
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
