# VAD implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject verified nonspeech before Discord transcription requests while preserving speech, raw recordings, and honest failure reporting.

**Architecture:** Reuse existing WAV conversion, then assess whole snippets with Silero in one bounded Node worker using single-threaded ONNX WebAssembly. Keep the mode off by default, preserve ASR on uncertain/unavailable results, and carry explicit final rejection through transcript consumers. Prove runtime compatibility before wiring the gate into meetings.

**Tech Stack:** Node 24.15.0, TypeScript, `node:worker_threads`, candidate `onnxruntime-web@1.30.0`, Silero v6.2.1, FFmpeg, Jest, Storybook, Playwright, Docker and existing Prometheus infrastructure.

**Spec:** [Approved speech-detection design](../specs/2026-10-13-speech-detection-design.md). Read both documents before execution.

**Status:** The user approved subagent-driven execution on October 13, 2026. Prerequisites and Tasks 1-5 are implemented and reviewed locally; Task 6 is in validation, and later tasks and final review remain. Default mode is off. Local implementation does not authorize production deployment or activation.

**Revision:** October 13 user clarification: the feature must be togglable and its improvement measurable. Tasks 4, 5 and 8 now require measurements for the off baseline as well as shadow/enforce, and one comparison report before promotion.

## Global constraints

- Retain the Alpine base image and repository resource budget of 0.5 vCPU / 1 GiB; these are source settings, not verified live ECS settings.
- One long-lived worker, one active job, at most four waiting jobs; deadlines include queue time: 500 ms fast, 1500 ms slow; restart cooldown 30 seconds.
- Candidate input is 16 kHz mono, 512-sample frames with 64-sample context, fresh recurrent state per clip.
- Candidate decision uses two consecutive frames at probability >= 0.5. A complete scan with peak < 0.35 may reject; otherwise preserve borderline speech as uncertain.
- Normalize only detector input toward -20 dBFS, maximum gain 100. Original PCM/WAV and offsets remain unchanged.
- Mode options are exactly `off`, `shadow`, `enforce`; default `off`, global superadmin control, Experimental group.
- Off/forced paths do no model work. Shadow never rejects or waits for model completion before provider submission. Uncertain/unavailable always preserve transcription.
- Model SHA-256 is `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`; bundle matching runtime assets and licenses; no meeting-time CDN downloads.
- No new table, cloud service, Docker rebase, audio trimming, personal-upload gate, language filter, prompt/echo-policy change, or historical rewrite.
- Rejection is not capture/provider failure. Preserve current non-rejected text-selection behavior, including successful-empty responses.
- Private recordings/references/results stay in private ops and ignored caches. Production replay, shadow activation, and enforcement retain their separate authorization.
- Do not add/widen PostHog events or send audio/content/identifiers in detector telemetry. Audio hashes used for local reuse never leave process/eval artifacts.
- If engine compatibility or acceptance budgets fail, stop and revise the design. Do not quietly substitute a detector or increase resources.

## Feature toggle and improvement measurement

The existing typed mode is the feature toggle. `off` preserves the current transcription path and performs no detector work; `shadow` measures detector decisions while retaining transcription; `enforce` may skip verified nonspeech. Operators can select these modes through the existing global superadmin settings without a code release. The setting is captured at meeting start, so switching off applies to new meetings. This clarification does not introduce server-level targeting or an immediate active-meeting kill switch.

Measurement remains enabled in all three modes. Turning off VAD must not turn off the baseline counters needed to compare it. Tasks 4–5 count Discord snippet outcomes and provider SDK submissions, including application retries and prompt/no-prompt voting. They also record decoded recording seconds independently of gate decisions, so reducing submitted audio cannot shrink the comparison denominator. SDK submissions are observed invocations, not proof of internal SDK transport retries or billable usage.

Task 8 produces one comparison report with these measures:

| Measure                                | Comparison and meaning                                                                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nonspeech false-transcript rate        | Human-labeled nonspeech clips with retained text / all reviewed nonspeech clips; compare the same clips with VAD off and enforce                                     |
| Speech rejection and empty-output rate | Separate rates for verified speech assessed as nonspeech and genuine speech with an empty final transcript, each / reviewed speech clips; include quiet/short groups |
| Transcript error                       | Aggregate WER on the same human references, prompt, model and repetitions                                                                                            |
| Provider work                          | Total SDK submissions and submitted audio seconds per decoded audio minute, by mode and fast/slow phase; include failed submissions and voting                       |
| Processing cost and reliability        | Assessment/end-to-end p95 latency, uncertainty/unavailability rates, queue saturation, restarts, memory and event-loop delay                                         |

Each report includes raw counts, denominators, absolute and relative differences, sample size, source/model/policy versions and mode. A zero baseline makes relative improvement undefined; it is never reported as 100% savings. Live comparisons use documented mode/time windows and recording-volume normalization, with traffic/composition differences recorded as limits. Live ASR text and shadow disagreement are not ground truth. Claim quality improvement only when the matched labeled evaluation supports it; fewer requests with unchanged quality is a separate result. Convert workload savings to money only with verified pricing/billing evidence.

The report is a required implementation artifact, not a later observability task. Reuse the existing internal Prometheus/Grafana route and private ops evidence workflow. No new customer analytics events or content-bearing metric labels are needed.

## Review focus

1. A single plausible speech frame or very short reply must preserve ASR, not be mislabeled nonspeech (Tasks 2, 5).
2. Anti-phase stereo or an impulse before quiet speech must not become artificial silence after downmix/normalization (Task 2).
3. A stale worker/fast-pass reply must not overwrite a newer final decision or justify reuse for changed bytes/policy (Tasks 3, 6).
4. A final rejection must remain excluded from live views, uploaded transcript JSON, notes, final-pass baselines, and auto-cancel input (Task 6).
5. Timeout, queue saturation, corrupt assets, and repeated restarts must preserve ASR, settle every request, and avoid a restart storm (Tasks 1, 3, 5).

## Execution prerequisites and ownership

- [ ] Inspect `git status` and use `superpowers:using-git-worktrees` at execution time. Preserve the current managed checkout and its pending UI work.
- [ ] Establish a reviewed quality/eval prerequisite commit before VAD work: `src/evals/transcription*.ts`, `src/services/transcriptionAudioService.ts`, `transcriptionSelectionService.ts`, the corresponding changes in `transcriptionService.ts` / `audio.ts` / guards / voting / noise gate, `test/evals`, focused transcription tests, eval scripts, and their package/docs/ignore changes. Use an explicit file list, never a broad `git add .`.
- [ ] Record the source SHA and current tests. Run `npm test -- --runInBand --coverage=false test/audio test/evals test/services/transcriptionSelectionService.test.ts test/services/transcriptionSnippetResult.test.ts test/services/transcriptionService.test.ts test/services/transcriptionPromptService.test.ts test/services/transcriptionFinalPassService.test.ts test/utils/transcriptionGuards.test.ts test/utils/transcriptionVote.test.ts test/utils/audioNoiseGate.test.ts test/observability/langfuseAudioAttachment.test.ts src/utils/__tests__/transcriptionVote.test.ts`. The current local baseline is 98 passing tests; compare against the checkpoint.
- [ ] Record the live-removal dependency: current `src/api/liveMeetings.ts`, `src/frontend/hooks/useLiveMeetingStream.ts` and `src/types/liveMeeting.ts` edits support removals, but are not committed. Independently review/checkpoint that small foundation or require its merge. Do not include the entire pending UI redesign in a VAD commit. Combined dashboard acceptance also depends on its existing local UI work being reviewed.
- [ ] Use an owned dependency tree. Current `node_modules` is a junction into another worktree; do not run `yarn add` against it. Resolve this with the execution worktree/setup workflow before changing dependencies.
- [ ] Inspect commit hooks. `scripts/lint-staged-win.js` currently auto-stages unrelated tracked changes. Use a clean checkout; if retaining a dirty checkout, run the exact file-scoped checks and use the previously documented invocation-only formatting-hook workaround. Do not skip required tests.
- [ ] Create no production replay, activation, or deployment while executing software tasks. Save private acceptance evidence in `D:/bench/chronote-ops` under that repository's instructions.

## File and responsibility map

| Files                                                                                                    | Responsibility                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `assets/speech-detection/{silero-v6.2.1.onnx,LICENSE,manifest.json}`                                     | Pinned model, provenance and package/asset hashes                        |
| `src/services/speechDetectionTypes.ts`, `speechDetectionPolicy.ts`                                       | Assessment, coverage, policy identity, worker protocol                   |
| `src/services/speechDetectionCore.ts`                                                                    | WAV validation, detector-only signal preparation and whole-clip decision |
| `src/services/speechDetectionWorker.ts`, `speechDetectionService.ts`                                     | Runtime adapter, worker lifecycle, bounded request service               |
| `src/services/transcriptionInputService.ts`                                                              | Conversion/admission ownership and cleanup                               |
| `src/services/transcriptionService.ts`, `src/audio.ts`, `src/types/audio.ts`                             | ASR admission, fast/final reuse and explicit rejection state             |
| `src/utils/audioTranscript.ts`, `src/services/{meetingTimeline,upload,autoRecordCancellation}Service.ts` | Consistent rejection without changing existing selection orders          |
| `src/config/{speechDetection,registry,keys,types}.ts`, `src/services/meetingConfigService.ts`            | One typed mode in existing configuration                                 |
| `src/metrics.ts`, `src/bot.ts`                                                                           | Content-free operational metrics and shutdown                            |
| `src/evals/transcriptionQuality{Case,Eval}.ts`, `transcriptionCorpus.ts`                                 | Actual production detector and reviewed corpus in eval runs              |
| `scripts/speech-detection/*.mjs`, `scripts/build-speech-assets.mjs`, package/build CI                    | Compatibility, packaging, smoke and benchmark                            |
| `test/fixtures/speech-detection`, focused tests and config stories                                       | Synthetic ground truth and public-interface regression coverage          |

## Shared contracts

Task 2 defines the following in `speechDetectionTypes.ts`. Later tasks must use these names.

```typescript
type SpeechPhase = "fast" | "slow";
type SpeechMetrics = {
  peakSpeechProbability: number;
  maxConsecutiveSpeechFrames: number;
  scannedFrames: number;
  totalFrames: number;
  gain: number;
};
type ScoredSpeechAssessment<K extends string> = {
  kind: K;
  policyFingerprint: string;
  metrics: SpeechMetrics;
};
type SpeechAssessment =
  | ScoredSpeechAssessment<"speech">
  | ScoredSpeechAssessment<"non_speech">
  | ScoredSpeechAssessment<"uncertain">
  | {
      kind: "unavailable";
      policyFingerprint: string;
      reason:
        | "off"
        | "forced"
        | "not_ready"
        | "queue_full"
        | "timeout"
        | "worker_error"
        | "invalid_input"
        | "invalid_output"
        | "asset_error"
        | "channel_cancellation"
        | "shutdown";
    };
type SpeechCoverage = {
  pcmSha256: string;
  audioBytes: number;
  policyFingerprint: string;
};
type SpeechAdmission =
  | { kind: "reused"; coverage: SpeechCoverage }
  | { kind: "not_enforced"; reason: "off" | "forced" | "shadow" }
  | {
      kind: "assessed";
      assessment: SpeechAssessment;
      coverage: SpeechCoverage;
    };
interface SpeechDetector {
  warm(): Promise<boolean>;
  assess(wav: Uint8Array, phase: SpeechPhase): Promise<SpeechAssessment>;
  shutdown(): Promise<void>;
}
type SpeechPolicy = {
  sampleRate: 16000;
  frameSamples: 512;
  contextSamples: 64;
  speechThreshold: 0.5;
  rejectionCeiling: 0.35;
  minSpeechFrames: 2;
  targetPeakDbfs: -20;
  maxGain: 100;
  cancellationRmsRatio: 0.1;
  normalizationVersion: "peak-v1";
  impulsePeakRatio: 10;
  negativeGuardVersion: "brief-peak-v1";
  modelSha256: string;
  engineVersion: string;
  policyFingerprint: string;
};
interface SileroSession {
  infer(
    input: Float32Array,
    state: Float32Array,
  ): Promise<{ probability: number; state: Float32Array }>;
}
```

Task 4 defines `SpeechDetectionMode` in the shared, runtime-free config module. Task 5 extends `SnippetTranscriptionResult`: successful results carry `admission: SpeechAdmission`; `skipped` results carry `reason: "non_speech"` and `coverage: SpeechCoverage`; failed results retain existing conversion/transcription reasons. Update existing typed mocks deliberately. Task 6 adds `AudioSnippet.lastFastSpeechCoverage?: SpeechCoverage` and `AudioFileData.finalSpeechRejection?: SpeechCoverage`. These are ephemeral state, not new history fields.

Implementation discovery, October 13, 2026: Task 2 adds the fingerprinted negative-only `brief-peak-v1` safeguard after synthetic impulse tests showed speech attenuation under whole-clip peak normalization. A complete negative scan becomes uncertain when 1 through `frameSamples` samples exceed whole-clip peak / `impulsePeakRatio`, and at least `minSpeechFrames` consecutive nonzero frames remain outside all frames containing those high samples. This covers the tested single, frame-boundary and separated impulses without changing audio, positive thresholds or normalization. The occupancy bound is aggregate high samples, not transient duration. Larger occupancy, peaks in every residual frame and insufficient residual frames remain limitations; impulse plus quiet noise may require ASR. All nine known controls retain their decisions. Default remains off, and reviewed real-speech acceptance is still required before activation.

Task 3 defines the following transport contracts in `speechDetectionTypes.ts`; the production adapter and controlled test transport implement the same boundary:

```typescript
type SpeechWorkerRequest = {
  type: "assess";
  requestId: number;
  wav: ArrayBuffer;
  policyFingerprint: string;
};
type SpeechWorkerReply =
  | { type: "ready"; policyFingerprint: string }
  | { type: "assessment"; requestId: number; assessment: SpeechAssessment };
type SpeechUnavailableReason = Extract<
  SpeechAssessment,
  { kind: "unavailable" }
>["reason"];
interface SpeechWorkerTransport {
  post(request: SpeechWorkerRequest): void;
  onReply(listener: (reply: SpeechWorkerReply) => void): () => void;
  onFailure(listener: (reason: SpeechUnavailableReason) => void): () => void;
  terminate(): Promise<void>;
}
type SpeechDetectorBindings = {
  policy: SpeechPolicy;
  spawn: (policy: SpeechPolicy) => SpeechWorkerTransport;
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => { cancel(): void };
};
```

Task 5 defines these conversion/admission contracts in `transcriptionInputService.ts`. The observer calls Task 4 metrics; it must not throw into transcription. Off/forced callers supply no detector. Shadow supplies one but never awaits its result before consuming the prepared WAV.

```typescript
type TranscriptionInputRequest = {
  pcm: Buffer;
  pcmFile: string;
  wavFile: string;
  mode: SpeechDetectionMode;
  phase: SpeechPhase;
  force: boolean;
  policyFingerprint: string;
  detector?: SpeechDetector;
  observe: (assessment: SpeechAssessment, durationMs: number) => void;
};
type PreparedTranscriptionInput = {
  wavFile: string;
  coverage: SpeechCoverage;
  admission: SpeechAdmission;
};
```

### Task 1: Prove and package the engine in Alpine

**Files:** Create `assets/speech-detection/*`, `scripts/speech-detection/runtime-smoke.mjs`, `test/scripts/speechDetectionRuntimeSmoke.test.ts` and synthetic fixtures/provenance under `test/fixtures/speech-detection`. Modify `.dockerignore`; after a successful probe, modify `package.json` / `yarn.lock`.

**Interfaces:** Produces a verified model manifest and `runtime-smoke.mjs --runtime-dir <node_modules-directory> --model <onnx-path>`. Exit 0 prints engine/node version, model hash, silence probability and state shape; invalid/mismatched assets exit nonzero without ASR/network calls.

- [ ] Write a CLI-boundary test, `rejectsCorruptModelBeforeSessionCreation`: a bad hash exits nonzero; no inference result is reported.

  ```typescript
  expect(corruptModelRun.exitCode).not.toBe(0);
  expect(corruptModelRun.inferenceResults).toHaveLength(0);
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/scripts/speechDetectionRuntimeSmoke.test.ts` and verify the expected failure before adding the script.
- [ ] Implement the smoke using the upstream 16 kHz input/context/state protocol. Add `.cache` to Docker exclusions first. Prepare only synthetic fixtures from `.cache/transcription-eval/synthetic-Ej2Ai8`: silence, tone, click, normal/quiet Yes and The Workshop, and Opus controls. Record hashes, independent synthesis references, and provenance; never copy production clips.
- [ ] Install the candidate only into the ignored probe directory: `npm install --prefix .cache/transcription-eval/js-runtime --no-save --package-lock=false onnxruntime-web@1.30.0`. Run the positive smoke locally; assert finite probability in [0,1], silence <0.35, and recurrent-state shape [2,1,128].
- [ ] Build the existing image: `docker build -t chronote-vad-baseline .`. In PowerShell, set `$vadRuntimePath = (Resolve-Path .cache/transcription-eval/js-runtime).Path`, then run `docker run --rm --network none --cpus 0.5 --memory 1g --mount "type=bind,source=$vadRuntimePath,target=/vad-runtime,readonly" chronote-vad-baseline node scripts/speech-detection/runtime-smoke.mjs --runtime-dir /vad-runtime/node_modules --model assets/speech-detection/silero-v6.2.1.onnx`. Expect exit 0 with successful real inference without CDN access. If compilation of the prerequisite branch fails, fix/report that baseline failure before interpreting VAD compatibility.
- [ ] After success, pin `onnxruntime-web@1.30.0` in the owned dependency tree with `yarn add --exact onnxruntime-web@1.30.0`. Record package integrity/version and matching WASM/.mjs hashes in the asset manifest. Run the CLI test and probe again with repository dependencies.
- [ ] Commit only this task's files as `build: verify and pin the speech detection runtime`. **Stop before Task 2 if the model cannot execute in the image.**

### Task 2: Implement the conservative whole-clip classifier

**Files:** Create `src/services/speechDetection{Types,Policy,Core}.ts`, `test/services/speechDetectionCore.test.ts`. Extend the synthetic fixture set only as needed.

**Interfaces:** Consumes Task 1 assets. Produces `assessWavSpeech(wav: Uint8Array, session: SileroSession, policy: SpeechPolicy): Promise<SpeechAssessment>`, `DEFAULT_SPEECH_POLICY`, and `createSpeechCoverage(pcm: Buffer, policyFingerprint: string): SpeechCoverage`. `SileroSession.infer(input: Float32Array, state: Float32Array)` returns `Promise<{probability: number; state: Float32Array}>`; context input has 576 samples and state has 256 values. Policy owns the fingerprint including model hash, engine version, normalization version and decision parameters.

- [ ] Write `preservesASRForOnePlausibleFrame` using an independently specified probability sequence [0.01, 0.7, 0.01]. Its public assessment must be `uncertain`. Include a complete [0.01, 0.02] negative and two consecutive [0.5, 0.5] positive frames.

  ```typescript
  expect(borderline.kind).toBe("uncertain");
  expect(completeNegative.kind).toBe("non_speech");
  expect(consecutivePositive.kind).toBe("speech");
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/services/speechDetectionCore.test.ts` and observe the missing classifier failure.
- [ ] Implement WAV chunk parsing and the specified decision/state protocol in `src/services/speechDetectionCore.ts` using Task 2's interfaces and shared policy values.
- [ ] Add a valid RIFF ancillary/odd-sized-chunk test that preserves the known signal's decision. Add one test cycle at a time for truncated/non-PCM input, nonfinite/out-of-range model output, and inference error; each returns unavailable, never nonspeech. Empty input is invalid; a valid zero-valued WAV is nonspeech. Validate the 256-value returned state as well as the probability.
- [ ] Add `doesNotRejectAntiPhaseSpeech`: opposing stereo channels retain nonzero channel energy but destroy the mono signal, so return `channel_cancellation`. Use a conservative cancellation check when mono RMS is <10% of the strongest channel RMS; do not change channel selection or resampling silently.
- [ ] Add real-model synthetic tests for quiet words, dictionary phrases, Opus, leading/trailing padding and an impulse before quiet speech. Assert input bytes are unchanged and repeated/interleaved speech-then-silence order yields independent results. If the impulse case cannot be safely classified, unavailable is acceptable; rejection of reviewed speech is not.
- [ ] Run this suite plus Task 1 smoke. Commit `feat: add conservative whole-snippet speech assessment`. Record any differences from Python; decision equivalence is required on its known controls, not bit-identical floating-point probabilities.

### Task 3: Run the classifier in a bounded reusable worker

**Files:** Create `src/services/speechDetection{Worker,Service}.ts`, `test/services/speechDetectionService.test.ts`, `test/services/speechDetectionWorker.integration.test.ts`, `test/helpers/speechDetectionHarness.ts`, `scripts/build-speech-assets.mjs`. Modify `package.json` build script to `tsc && node scripts/build-speech-assets.mjs`.

**Interfaces:** Consumes Task 2 classifier/types. Produces `createSpeechDetector(bindings: SpeechDetectorBindings): SpeechDetector`, lazy singleton `getSpeechDetector(): SpeechDetector`, and `shutdownSpeechDetector(): Promise<void>` (no initialization on shutdown). `warm()` awaits bounded readiness only for eval/smoke callers, returning false on failure; production admission warms asynchronously and does not await readiness. Bindings use the shared contracts above. `ControlledSpeechWorker` exposes `reply(reply: SpeechWorkerReply)` and `fail(reason: SpeechUnavailableReason)`; `FakeSpeechClock` exposes `advance(ms: number)` and implements bindings' clock/timer. Protocol has ready and request-ID-keyed replies; IDs are process-local and never telemetry identifiers.

- [ ] Write `settlesTimedOutWorkWithoutRejectingSpeech` through `detector.assess`: ready worker, fast request, advance clock to 500 ms, expect unavailable/timeout and eventual settlement.

  ```typescript
  clock.advance(500);
  await expect(pending).resolves.toMatchObject({
    kind: "unavailable",
    reason: "timeout",
  });
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/services/speechDetectionService.test.ts` and observe the missing service failure.
- [ ] Implement `createSpeechDetector` and the transport adapter in `src/services/speechDetectionService.ts`, using the shared bindings and protocol.
- [ ] Add cycles for one active plus four waiting jobs, immediate sixth-job queue_full, queued expiry removal, slow 1500 ms deadline, worker crash, and shutdown settling every pending promise. A stale reply from a terminated generation must be ignored.
- [ ] Add `doesNotRestartDuringCooldown`: after an active timeout, repeated requests at <30,000 ms return unavailable and spawn no replacement; one replacement may warm after the cooldown. Initialization/asset failure follows the same cooldown. Bound initialization itself to 30 seconds, then terminate and cool down; measure cold start before accepting this candidate bound. Not-ready requests continue immediately rather than waiting for warm-up. Mismatched ready/reply policy or malformed protocol output returns unavailable and cannot be treated as nonspeech.
- [ ] Copy owned WAV bytes before transfer; test that caller PCM/WAV remains readable and unchanged. Parse/normalize/infer inside the worker. Use one session and one active job, fresh recurrent state per job; load matching WASM assets locally with one engine thread, without browser proxy mode.
- [ ] Make source-mode and compiled-worker paths explicit. Source execution uses `ts-node/register`; compiled execution uses `dist/services/speechDetectionWorker.js`. Copy verified model/manifest/license assets to `dist/assets/speech-detection`. Test startup from source and a dist-only fixture with no source tree, then shutdown.
- [ ] Run `npm run build`, both worker suites, core suite and runtime smoke. Commit `feat: isolate speech assessment in a bounded worker`.

### Task 4: Add the single typed mode and operational metrics

**Files:** Create `src/config/speechDetection.ts`, `test/services/meetingConfigService.test.ts`, `test/trpc/configSpeechDetection.test.ts`, `test/metrics/speechDetectionMetrics.test.ts`. Modify `src/config/{registry,keys,types}.ts`, `src/services/meetingConfigService.ts`, `src/metrics.ts` and `src/bot.ts`. Extend `test/services/speechDetectionService.test.ts` for lazy startup/shutdown.

**Interfaces:** Produces `SPEECH_DETECTION_MODES`, `SpeechDetectionMode`, `DEFAULT_SPEECH_DETECTION_MODE = "off"`, and schema-validated `resolveSpeechDetectionMode(value: unknown): SpeechDetectionMode`. Registry key is `transcription.speechDetection.mode`; consumer key is `CONFIG_KEYS.transcription.speechDetectionMode`; resolved snapshot field is `MeetingRuntimeConfig.transcription.speechDetectionMode`. In `src/metrics.ts`, produce `recordSpeechAssessment(input: {mode: SpeechDetectionMode; phase: SpeechPhase; assessment: SpeechAssessment; durationMs: number}): void`, `recordSpeechRequestSkipped(input: {phase: SpeechPhase; audioSeconds: number}): void`, `recordSpeechSnippetOutcome(input: {mode: SpeechDetectionMode; phase: SpeechPhase; outcome: "transcribed" | "reused" | "vad_skipped" | "conversion_error" | "provider_error"; audioSeconds: number; durationMs: number}): void`, `recordSpeechProviderSubmission(input: {mode: SpeechDetectionMode; phase: SpeechPhase; candidate: "prompt" | "no_prompt"; audioSeconds: number}): void`, and `recordSpeechCapturedAudio(input: {mode: SpeechDetectionMode; audioSeconds: number}): void`. Inputs contain no audio/text/identifiers. New comparison metrics use the prefix `chronote_speech_detection_` with suffixes `snippet_outcomes_total`, `provider_submissions_total`, `submitted_audio_seconds_total`, `captured_audio_seconds_total`, and `end_to_end_duration_seconds`. Stable enum labels only; register each once and convert ms to seconds at the metric boundary.

- [ ] Write `defaultsSpeechDetectionOff` against resolved meeting config. Keep the no-model-work assertion at the actual admission/startup boundaries in Tasks 4–5.

  ```typescript
  expect(resolved.transcription.speechDetectionMode).toBe("off");
  expect(resolveSpeechDetectionMode("enforce")).toBe("enforce");
  expect(() => resolveSpeechDetectionMode("anything")).toThrow();
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/services/meetingConfigService.test.ts` and observe the missing mode failure.
- [ ] Register the global-only superadmin Experimental select and wire its typed snapshot, using the interfaces above.
- [ ] Add schema tests for all three modes and rejection of arbitrary values. Test the actual tRPC boundary: `config.setServerOverride` refuses the key with `Config key is not server scoped.`; global access remains superadmin-only. Do not put scope enforcement in the unvalidated repository writer.
- [ ] Preserve the existing meeting-start snapshot behavior: test that newly resolved meetings see a changed global mode, while an active meeting retains its captured mode. Explain this limit in Task 7 docs and rollback instructions. An immediate switch for active meetings would require a separate config-refresh design, not an undocumented per-snippet database lookup.
- [ ] Add metric-registry tests: unavailable is not a rejection; only actual enforce skips increment skipped-request/seconds counters; allowed labels are fixed mode/phase/kind/reason enums. Include duration histograms, queue saturation and worker restarts, using `recordSpeechWorkerRestart(): void` in `src/metrics.ts`. Model policy/coverage data, user IDs, text and audio never become labels.
- [ ] Add `offModeStillRecordsComparableBaseline` and `countsEveryApplicationSubmissionIncludingVoting`: an off-mode successful snippet records one outcome and one submission without starting a detector; a prompted request followed by a no-prompt vote records two submissions. Failed submissions also count. Reused text and enforced skips record their outcomes without a fictitious provider submission. Extend the existing metric label allowlist with fixed candidate/outcome enums.

  ```typescript
  expect(offBaseline.snippetOutcomes).toBe(1);
  expect(offBaseline.providerSubmissions).toBe(1);
  expect(detectorSpawn).not.toHaveBeenCalled();
  expect(votingRun.providerSubmissions).toBe(2);
  expect(reusedRun.providerSubmissions).toBe(0);
  ```

- [ ] Add shutdown coverage at the existing signal owner: stop new meetings, await their finalization, then shut down an initialized detector before process exit. API-only bootstrap and off mode must spawn no worker. Importing a module must not load ONNX or a model.
- [ ] Run new config/metrics tests and `test/services/unifiedConfigService.test.ts`; run `npx tsc --noEmit`. Commit `feat: configure and observe speech detection without enabling it`.

### Task 5: Gate provider submission at the shared admission boundary

**Files:** Create `src/services/transcriptionInputService.ts`, `test/services/transcriptionSpeechAdmission.test.ts`. Modify `src/services/transcriptionService.ts`, `src/types/audio.ts` and affected typed snippet test mocks.

**Interfaces:** Consumes detector/mode contracts. Produces `withPreparedTranscriptionInput<T>(input: TranscriptionInputRequest, consume: (prepared: PreparedTranscriptionInput) => Promise<T>): Promise<T>`. Request contains original PCM, owned PCM/WAV temp paths, mode, phase and explicit force flag. Prepared input contains WAV path, original coverage, and admission. This operation converts once, owns both files, and cleans both in finally even when the callback fails. `transcribeSnippet` retains its current API plus explicit `speechDetectionBypass?: boolean` and safe fast-reuse inputs defined in Task 6.

- [ ] Write `enforcedNonSpeechMakesNoProviderRequest`: fake external detector returns completed nonspeech; assert skipped/non_speech, zero OpenAI calls, original recording bytes intact, and both temp files cleaned.

  ```typescript
  expect(result).toMatchObject({ status: "skipped", reason: "non_speech" });
  expect(openAITranscribe).not.toHaveBeenCalled();
  expect(pcm.equals(originalPcm)).toBe(true);
  expect(remainingTempFiles).toEqual([]);
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/services/transcriptionSpeechAdmission.test.ts` and observe the unwanted provider call or missing skipped-result failure.
- [ ] Implement `withPreparedTranscriptionInput` and its `transcribeSnippet` integration after existing conversion and before prompt/provider/tracing work.
- [ ] Wire Task 4 measurements into the Discord snippet path in all modes. Record one terminal snippet outcome per invocation; record provider submission immediately before each SDK call, including existing application retries/voting, without changing provider retry behavior. Pass mode/phase through the existing transcription context. In the decoded capture handler in `src/audio.ts`, record captured seconds once per received PCM chunk before admission, not once per fast snapshot. Add an integration assertion that rejected/repeated fast snapshots leave the captured-seconds denominator unchanged. Exclude personal uploads and the separate final verification pass from these Discord comparison counters.
- [ ] Add one cycle per mode: off and explicit force do not call the detector; enforce speech/uncertain/unavailable call ASR; shadow starts assessment but submits ASR before a deliberately unresolved detector finishes. Late shadow results record only metrics and do not mutate text.
- [ ] Add `detectorErrorDoesNotBecomeProviderFailure` and delayed-read cleanup coverage. Copy input before scheduling shadow work; cleanup cannot delete a file still needed by the worker. Detector errors become unavailable and ASR proceeds; genuine conversion/provider errors retain current failure reasons and retries.
- [ ] Preserve existing suppression override semantics. Bypass is an explicit option passed from the forced live-command caller, not inferred from noise-gate or prompt-echo settings. Keep voting/prompt behavior unchanged.
- [ ] Run `test/services/transcriptionSpeechAdmission.test.ts`, `transcriptionSnippetResult.test.ts` and `transcriptionService.test.ts`. Commit `feat: skip transcription requests for completed nonspeech assessments`.

### Task 6: Preserve final authority across fast reuse and every transcript reader

**Files:** Modify `src/audio.ts`, `src/types/audio.ts`, `src/utils/audioTranscript.ts`, `src/services/{meetingTimeline,upload,autoRecordCancellation}Service.ts`. Extend `test/audio/startProcessingSnippet.test.ts`, `test/utils/audioTranscript.test.ts`, `test/services/{meetingTimeline,transcriptionFinalPass,autoRecordCancellation}Service.test.ts`; create `test/services/uploadServiceSpeechDetection.test.ts` and `test/e2e/live-transcript-rejection.spec.ts`.

**Interfaces:** Produces `isAudioFileSpeechRejected(file: AudioFileData): boolean`, shared by existing readers without replacing their non-rejected selection orders. `transcribeSnippet` accepts `reuseTranscript?: {text: string; coverage: SpeechCoverage}`. Matching proven-speech coverage/policy may reuse before conversion; otherwise the shared preparation operation assesses the full input once before taking a shortcut or calling ASR.

- [ ] Write the final-authority regression using existing `file(...)` helper:

  ```typescript
  const rejected = file({
    transcript: "old guess",
    slowTranscript: "",
    coalescedTranscript: "older guess",
    finalPassTranscript: "late guess",
    finalSpeechRejection: coverage,
  });
  expect(resolveAudioFileText(rejected)).toBe("");
  expect(
    getAudioTranscriptionFacts(audioContaining(rejected)).failedSegments,
  ).toBe(0);
  ```

  Define `coverage` and `audioContaining` locally from independent synthetic input.

- [ ] Run `npm test -- --runInBand --coverage=false test/utils/audioTranscript.test.ts` and observe older text being returned for the rejected file.
- [ ] Implement the final marker and `isAudioFileSpeechRejected` in `src/utils/audioTranscript.ts`, retaining existing selection order for unmarked files.

- [ ] Handle skipped results separately in fast and slow owners. Fast skip affects only its snapshot; final skip sets finalSpeechRejection and is not transcriptionFailed. Preserve prior usable fast text on a real provider failure. Record lastFastSpeechCoverage only for an accepted current revision with known speech and usable text.
- [ ] Test unchanged PCM+policy reuse; same byte length with changed contents; appended bytes; changed policy; and unavailable final assessment. Off/shadow retain existing shortcuts. A final assessment and fallback share one conversion/cleanup owner. Force bypass still prevents shortcut reuse where current behavior requires a fresh request.
- [ ] Record a reused outcome at the owner of a fast-finalization shortcut that bypasses `transcribeSnippet`; do not also count it as a new transcription or provider submission. Test this shortcut in off and enforce modes, preserving the single captured-audio denominator from Task 5.
- [ ] Test a delayed fast reply after finalization and an old worker reply after restart: neither restores rejected text. Compile, notes input and final-pass baseline remain empty for rejected files; final-pass reset must not clear the rejection marker. Do not modify successful-empty non-VAD policy.
- [ ] Guard direct readers using isAudioFileSpeechRejected. Timeline omits the event; uploaded JSON contains no rejected text; auto-cancel input excludes it. Add regression cases proving uploader nullish fallback and compiler usable-text fallback retain their previous behavior when no marker exists.
- [ ] Run relevant Jest suites plus `test/api/liveMeetings.test.ts` and `src/frontend/hooks/useLiveMeetingStream.test.tsx`. The combined E2E synthetic stream must show a fast guess and then remove it in both live-page and dashboard entry paths while original audio/offsets remain unchanged: `npm run test:e2e -- test/e2e/live-transcript-rejection.spec.ts`. Require the separately reviewed removal/UI foundations; report that dependency if unavailable.
- [ ] Commit `fix: keep final nonspeech rejection authoritative across transcript readers`.

### Task 7: Ship executable packaging checks and the mode's public explanation

**Files:** Modify `scripts/speech-detection/runtime-smoke.mjs`, `.github/workflows/ci-core.yml`, `Dockerfile` only if needed for asset inclusion, `docs/transcription-eval.md` and `apps/docs-site/docs/discord-meeting-notes.md`. Create `src/frontend/components/AdminConfigEntryList.stories.tsx` and `test/scripts/speechDetectionPackaging.test.ts`.

**Interfaces:** Upgrade the smoke to `--compiled`, invoking the built production service/worker instead of a separate model loop. Use `docs-authoring` for public docs. Preserve frontend metadata and Storybook react-docgen configuration.

- [ ] Write `compiledSmokeNeedsNoSourceTreeOrNetwork`: a dist-only backend layout starts the production worker, classifies known synthetic controls and shuts down. Missing worker/model/runtime assets and mismatched engine/asset hashes fail the smoke explicitly, even though the production service would fail open.

  ```typescript
  expect(smoke.exitCode).toBe(0);
  expect(smoke.silence.kind).toBe("non_speech");
  expect(smoke.normalSpeech.kind).toBe("speech");
  expect(smoke.shutdownComplete).toBe(true);
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/scripts/speechDetectionPackaging.test.ts` and observe the missing compiled smoke failure.
- [ ] Implement compiled smoke, backend asset copying and worker resolution to satisfy the dist-only test.
- [ ] Update the existing Docker CI job to run `docker run --rm --network none --cpus 0.5 --memory 1g meeting-notes-bot-ci node scripts/speech-detection/runtime-smoke.mjs --compiled`, replacing its current file-existence check. Confirm eval caches are absent from image contents.
- [ ] Add a tagged `vad-config` story using `getConfigEntry(CONFIG_KEYS.transcription.speechDetectionMode)`. Assert Experimental starts collapsed, options are off/shadow/enforce, default is off, and existing reset/inherited indicators work. Do not redesign the settings components.
- [ ] Run `npm run storybook` if the correct server is not already running, then `npm run test-storybook -- --maxWorkers=2 --includeTags vad-config`. Inspect saved screenshots with the VLM and the existing admin-config Playwright snapshots. Add a real scroll assertion only if this task changes scrolling.
- [ ] Explain whole-snippet gating, uncertainty/failure fallback, retained audio and default-off availability in public docs, without claiming a production rollout. Run `npm run docs:check`, `npm run build:all`, scoped lint, and packaging tests. Preserve any unrelated known fixture/dependency failures as explicit limits rather than silently fixing them.
- [ ] Commit `test: verify packaged speech detection and document its mode`.

### Task 8: Evaluate the production detector with fresh ground truth and bounded budgets

**Files:** Modify `src/evals/{transcriptionQualityCase,transcriptionQualityEval,transcriptionCorpus}.ts`, `docs/transcription-eval.md`. Create `test/evals/transcriptionProductionVad.test.ts`, `test/scripts/speechDetectionAcceptance.test.ts`, `scripts/speech-detection/benchmark.mjs`, `scripts/speech-detection/evaluate-detector.mjs` and `scripts/speech-detection/check-acceptance.mjs`.

**Interfaces:** Add CLI `--speech-detector off|production` and `--speech-mode shadow|enforce`; production detector defaults to enforce only inside explicit eval selection. Refuse conflicting `--vad-report`. Add `--batch-size 25 --batch-index N` (zero-based N, batch size 1–25), applying deterministic case-ID ordering after split selection. Report assessment/uncertainty/unavailability, actual request counts, model/policy hashes, and per-stage latency. Admission rules call the same helper as production.

- [ ] Write `productionDetectorSkipsWithoutInventingSuccessfulSpeechScores` and `unavailableAssessmentStillCallsProvider`. Keep preflight eligible runs unscored; failures and budget exhaustion remain nonzero/incomplete.

  ```typescript
  expect(nonSpeech.requests).toBe(0);
  expect(nonSpeech.status).toBe("skipped");
  expect(unavailable.requests).toBe(1);
  expect(eligible.score).toEqual({ scored: false });
  ```

- [ ] Run `npm test -- --runInBand --coverage=false test/evals/transcriptionProductionVad.test.ts` and observe the missing production-detector integration failure.
- [ ] Wire the actual production admission helper into the eval runner with explicit detector warm-up and guaranteed shutdown.
- [ ] Add deterministic batching tests: no missing/duplicate cases across batches, batch selection changes no label/hash, out-of-range index errors before paid calls. A 25-case, three-repeat slow batch can make at most 150 ASR attempts. Record run/source hashes and split/batch selection in each result.
- [ ] Run saved synthetic controls through the actual production worker in fast/slow and shadow/enforce, without changing prompt echo. Use independent detector labels, not model-generated references. Record differences from the earlier external-table experiment, including the uncertainty band.
- [ ] Extend the strict v1 corpus schema with optional `familyId` and `speakerDeviceProfileId` strings; release acceptance requires both, unique SHA values and no family shared between tune/holdout. Freeze a fresh private holdout: >=100 speech / >=50 nonspeech, >=20 quiet / >=20 short speech, >=5 speaker/device profiles. Labels must have human-reviewed provenance; ASR output is not ground truth. Record private review evidence `{version: 1, manifestSha256, reviewedAt, holdoutUntouchedSinceFreeze: true, tuningFamilyIds: string[]}`. Hashes/counts/leakage are machine checks; the truth of human review and untouched-holdout attestations remains an operator review, never an automatic guarantee. No arbitrary freshness expiry is invented. Never export clips/references to public git or analytics.
- [ ] Implement `evaluate-detector.mjs --manifest <private-manifest> --split holdout --runs 3 --output <private-path>` using the compiled worker and existing decode/conversion path. It performs zero provider calls, grades every labeled clip including clips the amplitude/duration gate would skip, and records SHA/policy/model/assessment for every repetition. Reuse existing corpus input-size/duration/hash checks and approved artifact roots. This detector-only result is separate from pipeline quality scores. Obtain the required production-replay authorization before provider replay.
- [ ] Compare pipeline baseline and VAD on the same split, prompt, echo setting and repetitions, in batches: `npm run eval:transcription -- --manifest <private-manifest> --mode pipeline --pass-mode slow --speech-detector production --speech-mode enforce --runs 3 --max-requests 150 --split holdout --batch-size 25 --batch-index N --artifact-dir D:/bench/chronote-ops/.cache/transcription-eval`. Replace production with off for baseline; repeat fast comparison. Dollar cost remains unpriced without verified rates.
- [ ] Benchmark the compiled service using `node scripts/speech-detection/benchmark.mjs --duration-seconds 120 --fast-per-second 4 --slow-per-second 1` in the 0.5 vCPU/1 GiB container. Use a fixed mixed two-second speech/nonspeech schedule, then separate duration buckets 0.3/2/10/60/180 seconds and a ten-job burst. Compare detector-off event-loop delay/RSS; report cold/warm, queue/deadline availability and per-bucket results. Burst overflow must fail open, not pass as a healthy assessment.
- [ ] Test and implement `check-acceptance.mjs --manifest <private-manifest> --review-evidence <private-review.json> --detector <detector-report.json> --baseline <batch-report-list.json> --candidate <batch-report-list.json> --benchmark <benchmark.json>`. Exit nonzero for incomplete/mismatched data, insufficient samples/profiles, duplicate SHA/family leakage, missing attestations, any verified speech classified nonspeech, <50% rejection of nonspeech admitted by the baseline amplitude gate, transcript regression, or missed resource budgets. Baseline/candidate must have identical cases, repetitions, prompt/echo/model/config and source version except VAD selection. Define transcript regression as an increase in matched aggregate WER or genuine-speech empty-output rate, or an increase in nonspeech false-positive rate; report quiet/short groups separately. Test each boundary through the CLI, including an apparently perfect report with a leaked family. Warm p95 must meet phase deadlines, steady-load availability >=95%, detector overhead <128 MiB and added p95 event-loop delay <20 ms. Acceptance reports attested evidence separately from machine-verified evidence; final review is still required.
- [ ] Add `--output <comparison-report.json>` to the acceptance checker. Emit the scorecard above with raw numerators/denominators, absolute/relative changes, unique clip counts separate from repeated attempts, per-family breakdowns, and a separate pass/fail/incomplete result. Use null for undefined relative change and unavailable money estimates. Add CLI tests for a zero baseline, incomplete data, and a candidate with lower provider work but worse speech quality; savings must not override failed quality gates. Document matching internal metric queries and mode/time windows in `docs/transcription-eval.md`; retain actual live evidence in private ops. Promotion requires the generated comparison report and a review of its interpretation.
- [ ] Commit the reusable eval/benchmark/checker code only as `eval: measure production speech detection and acceptance`. Save private results separately. **Do not declare enforcement ready if the fresh holdout or constrained benchmark is missing/failing.**

## Final validation and execution handoff

- [ ] Run the combined focused capture/transcription/config/worker/eval suites and product/script TypeScript checks. Run `npm run lint:check`, `npm run prettier:check`, `npm run build:all`, packaged container smoke, docs checks, tagged Storybook capture/VLM review, and relevant live-removal E2E. Tests need no paid API calls by default.
- [ ] Review the completed branch against the approved spec. Review source/worker lifetimes, cleanup, modes, callbacks, every transcript reader, and actual artifact contents. Recheck exact-head PR feedback/CI under repository skills if a PR is opened; do not call it merge-ready before the required 30-minute post-commit refresh.
- [ ] Keep production mode off through merge. Sandbox shadow comes before Sandbox enforcement, with benchmark/corpus evidence and existing standing Sandbox authority. Record runtime, calls, capture health and mode in private ops. Production activation/replay require their separate authorization. Rollback sets mode off for newly started meetings and preserves recordings/history; active meetings retain their initial snapshot, so do not promise an immediate in-progress kill switch.
- [ ] If only software/runtime gates are complete, report exactly that. Missing ground truth or operational evidence blocks promotion, not the completion of unrelated tested software tasks.
- [ ] Ask the user to review this plan and select execution. Recommended: subagent-driven task implementation and fresh review at each gate because runtime packaging, async lifecycle and transcript authority have different failure modes. Native execution with one whole-branch independent review is the lower-overhead alternative.

## Self-review record

Spec sections map to Tasks 1–8: runtime/assets (1, 3, 7), signal policy (2), worker bounds/failure (3), mode/metrics (4), shared admission (5), final authority and all readers (6), UI/docs (7), quality/resource/rollout evidence (8 and final validation). The user clarification adds an explicit toggle/measurement contract, off-mode baseline tests, gate-independent recording denominators and a required comparison report (4, 5, 8). The five review-focus inputs each have a named test cycle. Shared type/function names are fixed above, and later tasks consume those interfaces. No model runtime or product source was changed while writing this plan.

Task 6 strict-reuse ruling, October 13, 2026: this version reuses only exact original PCM plus policy proof. Missing, stale or changed proof goes through one full preparation and assessment, skips only completed nonspeech, and otherwise calls ASR. A new speech assessment does not introduce a second reuse path. Enforce can therefore add final SDK calls after uncertain or unavailable fast evidence or a policy change; the matched scorecard must measure this cost rather than assume savings. Off and shadow retain their existing shortcuts.
