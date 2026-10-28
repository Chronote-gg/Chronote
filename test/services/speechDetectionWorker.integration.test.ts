/** @jest-environment node */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  cpSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileSpeechFixture,
  removeOwnedFixture,
} from "../helpers/compiledSpeechDetectionFixture";
import { z } from "zod";
import { DEFAULT_SPEECH_POLICY } from "../../src/services/speechDetectionPolicy";

const root = path.resolve(__dirname, "../..");
const silence = path.join(
  root,
  "test/fixtures/speech-detection/tune-silence.wav",
);
const yes = path.join(root, "test/fixtures/speech-detection/yes-quiet.wav");
const outputSchema = z.object({
  warm: z.literal(true),
  coldStartMs: z.number().nonnegative(),
  silence: z.literal("non_speech"),
  speech: z.literal("speech"),
  repeated: z.literal(true),
  unchanged: z.literal(true),
});
const removeFixture = (fixture: string) =>
  removeOwnedFixture(fixture, "chronote-vad-");
function prepareCompiledFixture(): string {
  const fixture = mkdtempSync(path.join(tmpdir(), "chronote-vad-compiled-"));
  try {
    compileSpeechFixture(root, fixture, [
      "services/speechDetectionService.ts",
      "services/speechDetectionWorker.ts",
    ]);
    return fixture;
  } catch (error) {
    removeFixture(fixture);
    throw error;
  }
}
let compiledFixture: string | undefined;
beforeAll(() => {
  compiledFixture = prepareCompiledFixture();
}, 60000);
afterAll(() => {
  if (compiledFixture) removeFixture(compiledFixture);
});
function withCompiledFixture(check: (fixture: string) => void): void {
  if (!compiledFixture) throw Error("Compiled fixture was not prepared");
  const fixture = mkdtempSync(path.join(tmpdir(), "chronote-vad-case-"));
  try {
    cpSync(path.join(compiledFixture, "dist"), path.join(fixture, "dist"), {
      recursive: true,
    });
    expect(existsSync(path.join(fixture, "src"))).toBe(false);
    expect(existsSync(path.join(fixture, "tsconfig.json"))).toBe(false);
    check(fixture);
  } finally {
    removeFixture(fixture);
  }
}
function runFixtureScript(
  fixture: string,
  script: string,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "-e",
      script,
      path.join(fixture, "dist/services/speechDetectionService.js"),
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      timeout: 45000,
      env: {
        ...process.env,
        NODE_PATH: path.join(root, "node_modules"),
        ...extraEnv,
      },
    },
  );
}

function run(entry: string, cwd: string, source: boolean) {
  const script = `const {readFileSync}=require('node:fs'); const {performance}=require('node:perf_hooks'); const [entry,silence,yes]=process.argv.slice(1); const {getSpeechDetector,shutdownSpeechDetector}=require(entry); (async()=>{await shutdownSpeechDetector();const d=getSpeechDetector();const start=performance.now();const warm=await d.warm();const coldStartMs=performance.now()-start;try{if(!warm)throw Error('worker not ready');const wav=readFileSync(silence);const before=Buffer.from(wav);const s=await d.assess(wav,'slow');const a=await d.assess(readFileSync(yes),'slow');const b=await d.assess(readFileSync(yes),'slow');process.stdout.write(JSON.stringify({warm,coldStartMs,silence:s.kind,speech:a.kind,repeated:JSON.stringify(a)===JSON.stringify(b),unchanged:before.equals(wav)})+'\\n');}finally{await shutdownSpeechDetector();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
  return spawnSync(
    process.execPath,
    [
      ...(source ? ["-r", require.resolve("ts-node/register")] : []),
      "-e",
      script,
      entry,
      silence,
      yes,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: 45000,
      env: {
        ...process.env,
        NODE_PATH: path.join(root, "node_modules"),
        TS_NODE_TRANSPILE_ONLY: "true",
      },
    },
  );
}
it("starts source worker locally, preserves WAV, and resets recurrent state per clip", () => {
  const result = run(
    path.join(root, "src/services/speechDetectionService.ts"),
    root,
    true,
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const output = outputSchema.parse(JSON.parse(result.stdout));
  expect(output.coldStartMs).toBeLessThan(30000);
  console.info("source worker evidence", output);
}, 60000);
it(
  "starts a dist-only worker compiled from current sources with no source tree",
  () =>
    withCompiledFixture((fixture) => {
      const result = run(
        path.join(fixture, "dist/services/speechDetectionService.js"),
        fixture,
        false,
      );
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const output = outputSchema.parse(JSON.parse(result.stdout));
      expect(output.coldStartMs).toBeLessThan(30000);
      console.info("dist-only worker evidence", output);
    }),
  60000,
);
it.each(["missing", "corrupt"])(
  "returns unavailable for %s owned model assets",
  (damage) =>
    withCompiledFixture((fixture) => {
      const model = path.join(
        fixture,
        "dist/assets/speech-detection/silero-v6.2.1.onnx",
      );
      if (damage === "missing") rmSync(model);
      else {
        const bytes = readFileSync(model);
        bytes[0] ^= 1;
        writeFileSync(model, bytes);
      }
      const script = `const {getSpeechDetector,shutdownSpeechDetector}=require(process.argv[1]);(async()=>{const d=getSpeechDetector();try{const warm=await d.warm();const assessment=await d.assess(Uint8Array.of(1),'fast');process.stdout.write(JSON.stringify({warm,assessment}));}finally{await shutdownSpeechDetector();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
      const result = runFixtureScript(fixture, script, {
        TS_NODE_TRANSPILE_ONLY: "true",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        warm: false,
        assessment: { kind: "unavailable", reason: "not_ready" },
      });
    }),
  60000,
);
it(
  "withholds ready when first inference fails in a dist-only IPC worker",
  () =>
    withCompiledFixture((fixture) => {
      const assets = path.join(fixture, "dist/assets/speech-detection");
      const runtime = path.join(fixture, "node_modules/onnxruntime-web");
      mkdirSync(path.join(runtime, "dist"), { recursive: true });
      writeFileSync(
        path.join(runtime, "package.json"),
        JSON.stringify({
          name: "onnxruntime-web",
          version: "1.30.0",
          main: "dist/ort.node.min.js",
        }),
      );
      // Only this isolated failure-boundary fixture replaces the engine. Real success tests use the verified bundle.
      const fakeRuntime = `exports.env={wasm:{}};exports.Tensor=class {constructor(type,data,dims){this.type=type;this.data=data;this.dims=dims;}};exports.InferenceSession={create:async()=>({run:async()=>{require('node:fs').writeFileSync(process.env.SPEECH_TEST_MARKER,'ran');throw Error('fixture inference failure');},release:async()=>{}})};`;
      const fixtureManifest = z
        .object({
          runtime: z
            .object({
              assets: z.array(
                z.object({
                  file: z.string(),
                  bytes: z.number(),
                  sha256: z.string(),
                }),
              ),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(
          JSON.parse(readFileSync(path.join(assets, "manifest.json"), "utf8")),
        );
      for (const asset of fixtureManifest.runtime.assets) {
        const bytes = Buffer.from(
          asset.file.endsWith(".js") ? fakeRuntime : "fixture-only-placeholder",
        );
        writeFileSync(path.join(runtime, asset.file), bytes);
        asset.bytes = bytes.length;
        asset.sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      writeFileSync(
        path.join(assets, "manifest.json"),
        JSON.stringify(fixtureManifest),
      );
      const script = `const {getSpeechDetector,shutdownSpeechDetector}=require(process.argv[1]);(async()=>{try{process.stdout.write(JSON.stringify({warm:await getSpeechDetector().warm()}));}finally{await shutdownSpeechDetector();}})().catch(e=>{console.error(e);process.exitCode=1;});`;
      const result = runFixtureScript(fixture, script, {
        SPEECH_TEST_MARKER: path.join(fixture, "inference-ran"),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ warm: false });
      expect(readFileSync(path.join(fixture, "inference-ran"), "utf8")).toBe(
        "ran",
      );
    }),
  60000,
);

it.each(["abort", "hang", "malformed"])(
  "contains a child %s and preserves pending callers and input",
  (fault) =>
    withCompiledFixture((fixture) => {
      writeFileSync(
        path.join(fixture, "dist/services/speechDetectionWorker.js"),
        `const {DEFAULT_SPEECH_POLICY}=require('./speechDetectionPolicy');
        const {parentPort}=require('node:worker_threads');
        const port=parentPort||{postMessage:m=>process.send(m),on:(event,fn)=>process.on(event,fn)};
        port.postMessage({type:'ready',policyFingerprint:DEFAULT_SPEECH_POLICY.policyFingerprint});
        port.on('message',()=>{
          if(process.env.SPEECH_TEST_FAULT==='abort')process.kill(process.pid,'SIGKILL');
          if(process.env.SPEECH_TEST_FAULT==='hang')while(true){}
          if(process.env.SPEECH_TEST_FAULT==='malformed')port.postMessage({type:'assessment'});
        });`,
      );
      const script = `const {getSpeechDetector,shutdownSpeechDetector}=require(process.argv[1]);
        (async()=>{const detector=getSpeechDetector();const warm=await detector.warm();
        const wav=Buffer.from([1,2,3]);const before=Buffer.from(wav);
        try{const start=performance.now();const results=await Promise.all([detector.assess(wav,'fast'),detector.assess(wav,'slow')]);
        process.stdout.write(JSON.stringify({warm,results,unchanged:wav.equals(before),durationMs:performance.now()-start}));
        }finally{await shutdownSpeechDetector();}})().catch(()=>{process.exitCode=1});`;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          script,
          path.join(fixture, "dist/services/speechDetectionService.js"),
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            NODE_PATH: path.join(root, "node_modules"),
            SPEECH_TEST_FAULT: fault,
          },
        },
      );
      expect(result.status).toBe(0);
      const output = z
        .object({
          warm: z.literal(true),
          results: z
            .array(
              z.object({ kind: z.literal("unavailable"), reason: z.string() }),
            )
            .length(2),
          unchanged: z.literal(true),
          durationMs: z.number().max(2000),
        })
        .parse(JSON.parse(result.stdout));
      expect(output.results.map((assessment) => assessment.reason)).toEqual(
        Array(2).fill(
          fault === "hang"
            ? "timeout"
            : fault === "malformed"
              ? "invalid_output"
              : "worker_error",
        ),
      );
    }),
  60000,
);

it("settles shutdown when child spawning fails before an exit event", () => {
  const script = `process.execPath=process.argv[2];const {getSpeechDetector,shutdownSpeechDetector}=require(process.argv[1]);
  (async()=>{const warm=await getSpeechDetector().warm();await shutdownSpeechDetector();process.stdout.write(JSON.stringify({warm,shutdown:true}));})().catch(()=>{process.exitCode=1});`;
  const result = spawnSync(
    process.execPath,
    [
      "-r",
      require.resolve("ts-node/register"),
      "-e",
      script,
      path.join(root, "src/services/speechDetectionService.ts"),
      path.join(root, "missing-node-executable"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
    },
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ warm: false, shutdown: true });
}, 10000);

it(
  "releases the real child after its owner process is killed",
  () =>
    withCompiledFixture((fixture) => {
      const marker = path.join(fixture, "child-pid");
      const script = `const fs=require('node:fs');const cp=require('node:child_process');const fork=cp.fork;cp.fork=(...args)=>{const child=fork(...args);fs.writeFileSync(process.argv[2],String(child.pid));return child;};
  const {getSpeechDetector}=require(process.argv[1]);getSpeechDetector().warm().then(ready=>{if(!ready)process.exit(2);process.kill(process.pid,'SIGKILL')});`;
      const owner = spawnSync(
        process.execPath,
        [
          "-e",
          script,
          path.join(fixture, "dist/services/speechDetectionService.js"),
          marker,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 35000,
          env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
        },
      );
      expect(owner.status).not.toBe(0);
      const pid = Number(readFileSync(marker, "utf8"));
      const check = spawnSync(
        process.execPath,
        [
          "-e",
          `const pid=Number(process.argv[1]);const start=Date.now();const timer=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(timer);process.exit(0)}if(Date.now()-start>5000){clearInterval(timer);process.exit(1)}},50)`,
          String(pid),
        ],
        { encoding: "utf8", timeout: 7000 },
      );
      if (check.status !== 0)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      expect(check.status).toBe(0);
    }),
  60000,
);

it.each(["initializing", "inference"])(
  "exits on owner loss while %s awaits the engine",
  (phase) =>
    withCompiledFixture((fixture) => {
      const preload = path.join(fixture, "pause-engine.cjs");
      writeFileSync(
        preload,
        `const fs=require('node:fs');const ort=require('onnxruntime-web');setInterval(()=>{},1000);let calls=0;
  ort.InferenceSession.create=async()=>{if(process.env.SPEECH_TEST_PHASE==='initializing'){fs.writeFileSync(process.env.SPEECH_TEST_MARKER,String(process.pid));return new Promise(()=>{})}
  return {run:async()=>{if(++calls>1){fs.writeFileSync(process.env.SPEECH_TEST_MARKER,String(process.pid));return new Promise(()=>{})}return {output:{type:'float32',data:Float32Array.of(0)},stateN:{type:'float32',data:new Float32Array(256),dims:[2,1,128]}}},release:()=>new Promise(()=>{})}};`,
      );
      const marker = path.join(fixture, "paused-pid");
      const script = `const fs=require('node:fs');const cp=require('node:child_process');const child=cp.fork(process.argv[1],[process.argv[3]],{execArgv:['-r',process.argv[2]],serialization:'advanced',stdio:['ignore','ignore','ignore','ipc']});
  child.on('message',m=>{if(m.type==='ready')child.send({type:'assess',requestId:1,policyFingerprint:process.argv[3],wav:fs.readFileSync(process.argv[5]).buffer})});
  const timer=setInterval(()=>{if(fs.existsSync(process.argv[4])){clearInterval(timer);process.kill(process.pid,'SIGKILL')}},20);`;
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          script,
          path.join(fixture, "dist/services/speechDetectionWorker.js"),
          preload,
          DEFAULT_SPEECH_POLICY.policyFingerprint,
          marker,
          silence,
        ],
        {
          cwd: fixture,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            NODE_PATH: path.join(root, "node_modules"),
            SPEECH_TEST_PHASE: phase,
            SPEECH_TEST_MARKER: marker,
          },
        },
      );
      expect(result.status).not.toBe(0);
      const pid = Number(readFileSync(marker, "utf8"));
      const check = spawnSync(
        process.execPath,
        [
          "-e",
          `const pid=Number(process.argv[1]);const start=Date.now();const timer=setInterval(()=>{try{process.kill(pid,0)}catch{clearInterval(timer);process.exit(0)}if(Date.now()-start>3000){clearInterval(timer);process.exit(1)}},50)`,
          String(pid),
        ],
        { timeout: 5000 },
      );
      if (check.status !== 0)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Already exited. */
        }
      expect(check.status).toBe(0);
    }),
  60000,
);
