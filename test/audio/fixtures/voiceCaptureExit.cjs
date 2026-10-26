const fs = require("node:fs");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const ts = require("typescript");
const fault = process.argv[2];
if (fault === "fatal-startup") {
  Promise.reject(new Error("synthetic startup failure"));
} else if (fault === "graceful-startup") {
  Promise.resolve();
} else {
  const root = path.resolve(__dirname, "../../..");
  const audioPath = path.join(root, "src/audio.ts");
  const source = ts.createSourceFile(
    audioPath,
    fs.readFileSync(audioPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set([
    "getVoiceSubscriptions",
    "clearVoiceSubscription",
    "scheduleResubscribe",
    "subscribeToUserVoice",
    "isCaptureActive",
    "isCaptureIntakeStopped",
    "closeCaptureStream",
    "ensureRecordingCheckpointCapture",
  ]);
  const declarations = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text),
  );
  if (declarations.length !== names.size)
    throw new Error("Missing production teardown functions");
  const transpile = (code) =>
    ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
  const helperPath = path.join(root, "src/utils/disposeVoiceStream.ts");
  const helperModule = { exports: {} };
  if (fs.existsSync(helperPath)) {
    new Function(
      "require",
      "exports",
      transpile(fs.readFileSync(helperPath, "utf8")),
    )(require, helperModule.exports);
  }
  const lifetimeModule = { exports: {} };
  new Function(
    "exports",
    transpile(
      fs.readFileSync(
        path.join(root, "src/services/meetingProcessingLifetime.ts"),
        "utf8",
      ),
    ),
  )(lifetimeModule.exports);
  const voiceSubscriptions = new WeakMap();
  const api = new Function(
    "voiceSubscriptions",
    "captureStreamClosures",
    "runMeetingProcessingEffect",
    "getMeetingProcessingSignal",
    "disposeVoiceStream",
    "OpusDiagnosticDecoder",
    "VoiceConnectionStatus",
    "EndBehaviorType",
    `${transpile("const RESUBSCRIBE_DELAY_MS = 250, RECORD_SAMPLE_RATE = 48000, CHANNELS = 2, FRAME_SIZE = 960;\n" + declarations.map((node) => node.getText(source).replace(/^export /, "")).join("\n"))}\nreturn { clearVoiceSubscription, subscribeToUserVoice };`,
  )(
    voiceSubscriptions,
    new WeakMap(),
    lifetimeModule.exports.runMeetingProcessingEffect,
    lifetimeModule.exports.getMeetingProcessingSignal,
    helperModule.exports.disposeVoiceStream,
    class extends PassThrough {
      constructor() {
        super();
        if (fault === "timer-decoder" && attempts > 1)
          throw new Error("private decoder detail");
      }
      formatFailureDiagnostics() {
        return "";
      }
    },
    { Destroyed: "destroyed" },
    { Manual: "manual" },
  );
  const clear = api.clearVoiceSubscription;

  let attempts = 0;
  if (fault.startsWith("timer-") || fault === "handled-decoder") {
    const streams = [];
    const receiver = {
      subscriptions: new Map(),
      subscribe(userId) {
        attempts += 1;
        if (fault === "timer-receiver" && attempts > 1)
          throw new Error("private receiver detail");
        const stream = new PassThrough();
        streams.push(stream);
        this.subscriptions.set(userId, stream);
        return stream;
      },
    };
    const meeting = {
      meetingId: "synthetic-meeting",
      voiceChannel: { members: new Map([["synthetic", {}]]) },
      connection: { receiver, state: { status: "ready" } },
      audioData: {},
    };
    let markers = 0;
    console.log = () => {};
    console.warn = (message) => {
      if (message === "Voice subscription replacement failed:") markers += 1;
    };
    api.subscribeToUserVoice(meeting, "synthetic").then(() => {
      const state = voiceSubscriptions.get(meeting).get("synthetic");
      state.decoder.emit(
        "error",
        new Error("synthetic handled decoder failure"),
      );
      setTimeout(() => {
        const expectedMarkers = fault === "handled-decoder" ? 0 : 1;
        const handled =
          attempts === 2 &&
          markers === expectedMarkers &&
          meeting.audioData.captureIncomplete === true;
        clear(meeting, "synthetic");
        process.stdout.write(`callbackFailureHandled=${handled}\n`);
        if (!handled) process.exitCode = 2;
      }, 350);
    });
  } else {
    const opusStream = new PassThrough();
    const decoder = new PassThrough();
    opusStream.pipe(decoder);
    const onError = () => {};
    opusStream.on("error", onError);
    decoder.on("error", onError);
    const state = {
      opusStream,
      decoder,
      decodedStream: decoder,
      ownedListenerCleanups: new Map([
        [opusStream, [() => opusStream.removeListener("error", onError)]],
        [decoder, [() => decoder.removeListener("error", onError)]],
      ]),
    };
    const meeting = {
      connection: {
        receiver: { subscriptions: new Map([["synthetic", opusStream]]) },
      },
    };
    voiceSubscriptions.set(meeting, new Map([["synthetic", state]]));
    const failing =
      process.argv[2] === "pending-decoder" ? decoder : opusStream;
    failing.destroy(new Error("synthetic queued fault"));
    clear(meeting, "synthetic");
    clear(meeting, "synthetic");
    setImmediate(() => process.stdout.write("teardownCompleted=true\n"));
  }
}
