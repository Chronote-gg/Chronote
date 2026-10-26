// Generated-only native fixture. This preload executes before every application import.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
require("dotenv").config = () => ({ parsed: {} });
Object.assign(process.env, {
  MOCK_MODE: "true",
  MEETING_TEMP_DIR: "/fixture-output/temp",
  ENABLE_OAUTH: "false",
  ENABLE_MCP: "false",
  PORT: "3001",
  DISCORD_BOT_TOKEN: "synthetic",
  DISCORD_CLIENT_ID: "synthetic",
  DISCORD_CLIENT_SECRET: "",
  DISCORD_CALLBACK_URL: "http://localhost/callback",
  OPENAI_API_KEY: "synthetic",
  OPENAI_ORG_ID: "",
  OPENAI_PROJECT_ID: "",
  SESSION_SECRET: "synthetic",
  OAUTH_SECRET: "synthetic",
  FRONTEND_SITE_URL: "http://localhost",
  LANGFUSE_PUBLIC_KEY: "",
  LANGFUSE_SECRET_KEY: "",
  LANGFUSE_TRACING_ENABLED: "false",
  POSTHOG_KEY: "",
  STRIPE_SECRET_KEY: "",
  STRIPE_WEBHOOK_SECRET: "",
  NOTION_CLIENT_ID: "",
  NOTION_CLIENT_SECRET: "",
  NOTION_TOKEN_ENCRYPTION_SECRET: "",
  TRANSCRIPTS_BUCKET: "",
  STORAGE_ACCESS_KEY_ID: "",
  STORAGE_SECRET_ACCESS_KEY: "",
  AWS_ACCESS_KEY_ID: "synthetic",
  AWS_SECRET_ACCESS_KEY: "synthetic",
  AWS_SESSION_TOKEN: "",
  AWS_EC2_METADATA_DISABLED: "true",
  REDIS_URL: "",
  CACHE_REDIS_URL: "",
  ECS_CONTAINER_METADATA_URI_V4: "",
  ECS_AGENT_URI: "",
  AWS_EXECUTION_ENV: "",
  APP_CONFIG_ENABLED: "false",
});
const output = "/fixture-output";
fs.mkdirSync(path.join(output, "objects"), { recursive: true });
function publish(name, value) {
  const target = path.join(output, name);
  const temporary = `${target}.pending`;
  const descriptor = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
}
const objectPath = (key) =>
  path.join(
    output,
    "objects",
    crypto.createHash("sha256").update(key).digest("hex"),
  );
const storage = require("/app/dist/services/storageService");
storage.uploadObjectToS3 = async (key, bytes, _contentType, options = {}) => {
  options.signal?.throwIfAborted();
  const file = objectPath(key);
  const descriptor = fs.openSync(file, options.immutable ? "wx" : "w");
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return key;
};
storage.fetchObjectBytesFromS3 = async (key, signal) => {
  signal?.throwIfAborted();
  return fs.readFileSync(objectPath(key));
};
const db = require("/app/dist/db");
const getRepository = db.getDeploymentControlRepository;
db.getDeploymentControlRepository = () => {
  const repository = getRepository();
  const transition = repository.transitionMeetingHistory;
  repository.transitionMeetingHistory = async (input) => {
    const result = await transition(input);
    if (result === "applied")
      publish("history.json", await repository.getMeetingHistory(input.key));
    return result;
  };
  return repository;
};
const lifecycle = require("/app/dist/services/runtimeLifecycleService");
let meeting;
let apiSettled = false;
process.on("exit", (code) => {
  publish("exit.json", {
    code,
    pid: process.pid,
    node: process.version,
    apiSettled,
    counts: lifecycle.getRuntimeWorkCounts(),
    captureFinished: meeting?.finished ?? null,
    encodedBytes:
      meeting?.audioData.outputFileName &&
      fs.existsSync(meeting.audioData.outputFileName)
        ? fs.statSync(meeting.audioData.outputFileName).size
        : 0,
  });
});
function generatedPcm() {
  const { OpusEncoder } = require("@discordjs/opus");
  const encoder = new OpusEncoder(48000, 2);
  const pcm = Buffer.alloc(960 * 4);
  for (let frame = 0; frame < 960; frame++) {
    const sample = Math.round(
      Math.sin((frame * 2 * Math.PI * 440) / 48000) * 5000,
    );
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  return Buffer.from(encoder.decode(encoder.encode(pcm)));
}
async function recordingFixture() {
  const leases = require("/app/dist/services/activeMeetingLeaseService");
  const audio = require("/app/dist/audio");
  const {
    createRecordingCheckpointCapture,
  } = require("/app/dist/services/recordingCheckpointCapture");
  const {
    appendMeetingCheckpointArtifacts,
  } = require("/app/dist/services/recordingCheckpointService");
  const startedAt = Date.now() - 31000;
  const history = {
    guildId: "synthetic-native",
    channelId_timestamp: "voice#synthetic",
    meetingId: "synthetic-native",
    channelId: "voice",
    timestamp: new Date(startedAt).toISOString(),
    participants: [],
    duration: 0,
    transcribeMeeting: false,
    generateNotes: false,
  };
  const result = await leases.tryAcquireMeetingLease({
    guildId: history.guildId,
    meetingId: history.meetingId,
    voiceChannelId: "voice",
    textChannelId: "text",
    isAutoRecording: false,
    sessionMode: "meeting",
    reservedAt: startedAt,
    history,
  });
  if (result.kind !== "admitted")
    throw new Error(`Fixture admission rejected: ${result.reason}`);
  meeting = {
    ...history,
    channelId: "text",
    voiceChannel: { id: "voice" },
    reservation: result.reservation,
    captureStartedAt: new Date(startedAt),
    captureAudio: true,
    recordingCaptureState: {
      kind: "capturing",
      startedAt: new Date(startedAt).toISOString(),
    },
    audioData: {},
    setFinished() {},
    sessionMode: "meeting",
  };
  leases.attachMeetingReservation(meeting, result.reservation);
  meeting.recordingCapture = createRecordingCheckpointCapture({
    directory: path.join(output, "capture"),
    startedAt,
    signal: meeting.ownershipSignal,
    commit: async (artifacts, signal) =>
      (await appendMeetingCheckpointArtifacts(meeting, artifacts, signal))
        .kind === "committed",
    stopCapture: () => {
      throw new Error("Unexpected fixture capture cutoff");
    },
  });
  audio.openOutputFile(meeting);
  const frame = generatedPcm();
  const saved = Buffer.concat(Array.from({ length: 1500 }, () => frame));
  meeting.recordingCapture.push("synthetic-source", saved, startedAt);
  meeting.audioData.audioPassThrough.write(saved);
  await meeting.recordingCapture.settled();
  if (!meeting.recordingCheckpoint)
    throw new Error("Initial generated checkpoint not acknowledged");
  publish(
    "before.json",
    await db
      .getDeploymentControlRepository()
      .getMeetingHistory(result.reservation.historyKey),
  );
  const tail = Buffer.concat(Array.from({ length: 10 }, () => frame));
  meeting.recordingCapture.push("synthetic-source", tail, startedAt + 30000);
  meeting.audioData.audioPassThrough.write(tail);
}
async function startFixture() {
  const mode = process.argv[1].includes("/bot/")
    ? "bot"
    : process.argv[1].includes("/api/")
      ? "api"
      : "all";
  if (process.env.RECORDING_FAULT_FIXTURE === "true")
    await require("/app/nativeRecoveryFaults.cjs")(
      output,
      generatedPcm(),
      publish,
    );
  if (mode !== "api") await recordingFixture();
  const {
    runRuntimeApiOperation,
  } = require("/app/dist/services/runtimeApiOperationService");
  const api = runRuntimeApiOperation(
    "synthetic-native-api",
    async (operation) => {
      await operation.read(
        () =>
          new Promise((resolve) =>
            operation.signal.addEventListener(
              "abort",
              () =>
                setTimeout(() => {
                  apiSettled = true;
                  resolve();
                }, 75),
              { once: true },
            ),
          ),
      );
    },
  );
  void api.catch(() => {});
  // The owned operation has passed admission before the parent sends a signal.
  await new Promise((resolve) => setImmediate(resolve));
  publish("ready.json", {
    mode,
    pid: process.pid,
    node: process.version,
    counts: lifecycle.getRuntimeWorkCounts(),
  });
}
lifecycle.whenRuntimeServing(() => {
  void startFixture().catch((error) => {
    console.error(error);
    process.exit(2);
  });
});
