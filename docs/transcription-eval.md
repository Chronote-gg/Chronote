# Transcription eval runner

This CLI runs repeated transcription passes against labeled audio and measures unwanted text, dropped speech, recognition errors, and request usage.

## Production pipeline corpus runs

Use `--manifest` to compare the raw provider with the same audio gate, conversion, transcript guards, and candidate selection used by the bot. No Langfuse dataset is required. Corpus tracing stays disabled and results stay in an ignored artifact directory.

```powershell
npm run eval:transcription:corpus -- --speech
npm run eval:transcription -- --manifest <printed-manifest-path> --mode preflight --runs 1
npm run eval:transcription -- --manifest <printed-manifest-path> --mode provider --runs 3 --max-requests 100
npm run eval:transcription -- --manifest <printed-manifest-path> --mode pipeline --pass-mode fast --runs 3 --max-requests 100
npm run eval:transcription -- --manifest <printed-manifest-path> --mode pipeline --pass-mode slow --runs 3 --max-requests 150
```

Corpus preparation generates eight nonspeech controls. `--speech` adds eight short TTS requests and produces normal, quiet, and Opus speech variants. Synthetic labels come from independent synthesis inputs; they are controls, not proof of real Discord quality.

Each manifest case requires an audio SHA-256, split, tags, and explicit speech/nonspeech/unreviewed label with provenance. Every repetition is scored. An empty expected transcript means nonspeech; an absent reference is unscored. Provider failures and exhausted budgets stay unscored, retain request accounting, and cause a nonzero exit code. SDK retries are disabled in corpus mode. Usage is retained for every successful response; dollar cost is unpriced.

`--policy` loads validated guard settings, `--prompt-file` changes the prompt, and `--split tune` limits development runs. Keep a fresh holdout separate from tuning. `--vad-report` applies experimental detector decisions bound to each clip's hash. The optional Silero Python script is an offline experiment and does not change the production bot.

Keep real recordings, references, and results in the private ops workspace. Use `--artifact-dir D:/bench/chronote-ops/.cache/transcription-eval`, with any explicit `--output` inside that directory. Production recording replay retains the private ops authorization requirement.

See [the October 13 findings and run instructions](analysis/2026-10-13-transcription-quality-evals.md) for the corpus format, optional speech detector, observed results, and release limits.

## Bundled speech detection and packaging proof

The Discord pipeline includes `transcription.speechDetection.mode`, with `off`, `shadow`, and `enforce` options. The default is `off`. It is a global superadmin setting in Experimental, captured at meeting start. Switching off changes new meetings and does not cancel detector work in an active meeting.

Enforce mode gates whole snippets, retaining original audio and offsets. Uncertain or unavailable assessments preserve transcription. Forced transcription bypasses the detector. Exact audio and policy coverage can be reused, but uncertainty or a failed coverage proof can require additional final-pass SDK submissions. This behavior alone proves neither quality improvement nor request savings.

The bundled model and matching runtime assets need no meeting-time download. After `npm run build`, verify the production service and worker with synthetic controls:

```powershell
node scripts/speech-detection/runtime-smoke.mjs --compiled
npm test -- --runInBand --coverage=false test/scripts/speechDetectionPackaging.test.ts
docker run --rm --network none --cpus 0.5 --memory 1g meeting-notes-bot-ci node scripts/speech-detection/runtime-smoke.mjs --compiled
```

The smoke validates model/runtime versions and hashes, requires worker readiness, classifies silence as nonspeech and normal speech as speech, and waits for shutdown. Packaging failures exit nonzero even though production detector failures preserve transcription. The test compiles current service/worker sources into a temporary backend layout with no source tree, tsconfig, or evaluation cache. The Docker check verifies offline inference under the repository's resource budget. These checks prove executable packaging, not hosted deployment or production quality.

Compare matched, human-reviewed recordings with the mode off and enforce before claiming improvement. Report speech rejection separately from empty transcript output, nonspeech retained-text rate, WER, SDK submissions and submitted audio seconds per decoded audio minute, latency, uncertainty/unavailability, queue saturation, restarts, memory, and event-loop delay. Include raw counts, denominators, sample sizes, model/policy versions, and quiet/brief speech groups. SDK invocation counts are not verified transport retries or billable usage. Preserve the private-recording and activation approval boundaries above.

## Local file runs

```bash
yarn eval:transcription --file audio/sample.wav --runs 10 --language en --temperature 0
```

Optional flags:

- --prompt-file prompts/chronote-transcription-cleanup-chat.md
- --glossary-file docs/evals/transcription-glossary.txt
- --reference-file docs/evals/reference.txt
- --output .cache/transcription-eval/run.json

## Bedrock Data Automation runs

```bash
BEDROCK_DATA_AUTOMATION_PROFILE_ARN=arn:aws:bedrock:us-east-1:123456789012:data-automation-profile/abc
```

```bash
yarn eval:transcription --provider bedrock --file audio/sample.wav --runs 3
```

Required env vars for Bedrock evals:

- BEDROCK_DATA_AUTOMATION_PROFILE_ARN
- BEDROCK_DATA_AUTOMATION_INPUT_BUCKET (optional if TRANSCRIPTS_BUCKET is set)
- BEDROCK_DATA_AUTOMATION_OUTPUT_BUCKET (optional if TRANSCRIPTS_BUCKET is set)

## Langfuse dataset runs

**Needs seeding first, and seeding needs a labelled clip (verified 2026-07-30).**
No `transcription-eval` dataset exists. Unlike the notes and summary evals, this
one cannot be seeded from the sample file as it stands: `docs/evals/transcription-eval.dataset.json`
points at `audio/clip.wav`, which is not in the repo, and grading needs a
reference transcript that a human has checked. Transcribing a clip with the same
model to produce that reference would be circular and grade nothing.

So seeding this is a content task, not a code task: add a short audio file, write
its reference transcript by hand, point a case at both, then:

```bash
yarn evals:upload --dataset transcription-eval --file docs/evals/transcription-eval.dataset.json
```

The local `--file` runs above work today and need no dataset.

Do not point this at the project's existing `Transcription` dataset. That one was
created outside this repo, holds a single item with an empty `expectedOutput`, and
its input shape does not match `DatasetInputSchema`, so it cannot grade. The
kebab-case name is the convention here, matching `meeting-notes` and
`meeting-summary`.

```bash
LANGFUSE_EVAL_DATASET=transcription-eval
```

```bash
yarn eval:transcription --dataset transcription-eval --runs 5
```

Dataset input example:

```json
{
  "file": "audio/clip.wav",
  "language": "en",
  "prompt": "...",
  "promptFile": "prompts/chronote-transcription-cleanup-chat.md",
  "glossaryFile": "docs/evals/transcription-glossary.txt",
  "runs": 5,
  "temperature": 0
}
```

Expected output example:

```json
{
  "transcript": "Reference transcript text"
}
```

Notes:

- Paths are resolved from the repo root.
- WER uses Unicode word segmentation and Levenshtein distance across every repetition. Exact match, nonspeech unwanted-output rate, and speech-drop rate also cover every repetition. Empty references are scoreable.
- With --drop-prompt-like, prompt leakage outputs are counted but replaced with empty strings.
- Chat prompt files are reduced to their system messages before use.
- Bedrock evals require AWS S3 and ignore STORAGE_ENDPOINT overrides.
- Sample dataset payloads live in docs/evals/transcription-eval.dataset.json.

## Production speech detector evaluation

The runtime default remains `off`. The October 13 constrained development benchmark
failed steady availability and memory overhead gates. Human-reviewed release
holdout evidence is also missing. This is tested evaluation tooling, not approval
to enforce speech rejection. Preserve the failed measurements when revising the
design. Do not increase CPU, memory, deadlines, or substitute model/runtime assets
without reviewing that design change.

The October 27 child-process recovery benchmark used the same 0.5 CPU / 1 GiB
limits and workload. Steady availability improved to 600/600 assessments, with
fast/slow p95 latency of 27.12/37.34 ms and no steady restarts. Total process-tree
RSS overhead remained 203,436,032 bytes (about 194 MiB), failing the original
128 MiB gate. Process isolation and passing latency do not establish resource
acceptance. Later heap, compiler and asset-loading probes did not meet that gate
and were not adopted.

Build first with `npm run build`. The normal build emits
`dist/assets/speech-detection/eval-build.json` after TypeScript compilation. The detector-only and
benchmark scripts load `dist`, including the actual production worker. Pipeline
runs call `withPreparedTranscriptionInput` and the shared transcription selection
service. The manifest entrypoint delegates to the compiled corpus runner for both
baseline and candidate. Its runtime-free provenance helper verifies the source
and compiled files against the normal build association before decoding or paid
provider setup. A missing or stale association requires another normal build.
Direct source callers report loader `source` and cannot satisfy release acceptance.
They do not maintain another VAD classifier or admission policy.

```powershell
node scripts/speech-detection/evaluate-detector.mjs --manifest <private-manifest> --split holdout --runs 3 --artifact-dir D:/bench/chronote-ops/.cache/transcription-eval --output D:/bench/chronote-ops/.cache/transcription-eval/detector.json
npm run eval:transcription -- --manifest <private-manifest> --mode pipeline --pass-mode slow --speech-detector production --speech-mode enforce --runs 3 --max-requests 150 --split holdout --batch-size 25 --batch-index 0 --artifact-dir D:/bench/chronote-ops/.cache/transcription-eval
```

Detector-only evaluation makes zero provider calls, grades every clip regardless of
amplitude/duration admission, checks the source audio hash/size/duration, and
records each repetition's assessment and timings. `--pass-mode fast|slow` controls
its production deadline. Default maximum clip duration is 60 seconds, with a
32 MiB input limit. Run detector-only controls without converting their labels
into human ground truth. An unavailable assessment makes detector-only evidence
incomplete, exits nonzero, and retains the measured result.

Pipeline provider replay of private recordings requires its separate authorization.
For an authorized replay, repeat each numbered batch until the split is exhausted,
replace `production` with `off` for baseline (omit `--speech-mode`), and repeat
both comparisons with `--pass-mode fast`. Baseline and candidate must use identical
source, model, prompt, echo and other policy settings, split, and repetitions.
Selection sorts case IDs after split filtering, then takes at most 25 cases.
An out-of-range batch errors before decoding or provider setup. Three repetitions
of 25 slow clips allow at most 150 SDK invocations, including prompt/no-prompt
voting. SDK retries are disabled. Failed submitted calls count toward work;
budget exhaustion is incomplete. Eligible preflight rows remain unscored and
cannot satisfy pipeline acceptance.

`--speech-detector off|production` defaults to `off`. Explicit production evals
use `--speech-mode enforce` by default, or `shadow` to observe without changing
provider admission. Shadow assessment completion is collected after provider
submission. External `--vad-report` and production detection conflict. Reports
include source/run/manifest/model/policy hashes, selection, decode/conversion,
admission/assessment, provider and end-to-end time. Comparison concerns snippet
ASR work only. End-to-end duration uses the same post-capture boundary in off,
enforce and shadow: duration/amplitude admission, per-attempt preparation,
provider selection and temporary-file cleanup. Corpus decode and detector warm-up
are recorded separately and excluded. Gate skips perform zero conversions.
Conversion time measures the actual conversion call on each attempt; admission
time includes preparation and any awaited enforce assessment, so these stages
overlap and must not be summed. Shadow assessment time may overlap provider work.
Waiting only to collect its completed artifact is excluded from end-to-end time.
Older reports that cached off-mode conversion used a different boundary and must
be regenerated before a matched latency comparison.

Final-pass exact-coverage reuse, changed PCM and whole-meeting
reprocessing can add SDK calls that this snippet replay does not model; use live
SDK counters to measure those calls, and never extrapolate guaranteed savings.

### Human review and holdout freeze

Keep clips, references, label worksheets, provider evidence, and reports in private
ops or an ignored artifact directory. An unreviewed candidate pool is not a frozen
release holdout. Before freezing, a human listens to each clip and records the
label/reference, review identity/date, family and speaker/device profile in the
private review worksheet. Do not fill references from ASR/model output, infer a
human signature, or tune on the proposed holdout.

The strict version 1 manifest accepts optional `familyId` and
`speakerDeviceProfileId`; release acceptance requires both. Related recordings
share a family. Put whole families in tune or holdout, never both. Collect at least
100 speech and 50 nonspeech unique audio hashes, at least 20 speech clips tagged
`quiet` and 20 tagged `short`, and at least five speech speaker/device profiles.
Every holdout label must carry `provenance: "human-reviewed"`. Speech references
must be nonempty. Nonspeech labels contain no transcript. After human review,
freeze the manifest bytes and record this private review evidence:

```json
{
  "version": 1,
  "manifestSha256": "<sha256 of frozen manifest bytes>",
  "reviewedAt": "<actual review timestamp>",
  "holdoutUntouchedSinceFreeze": true,
  "tuningFamilyIds": ["<every family used for tuning>"]
}
```

The checker verifies counts, hashes, label provenance fields, family separation
and matching artifacts. It cannot verify that a person reviewed labels or that
the holdout was untouched. Those statements remain operator attestations and
require final review. There is no invented age-based expiry.

### Resource evidence and comparison report

Run in the approved immutable Alpine image with `--network none --cpus 0.5
--memory 1g`, mounting final compiled artifacts and these scripts read-only when
needed. Record the image ID and mount hashes with private results. Never build
from a dirty/private context.

```powershell
node scripts/speech-detection/benchmark.mjs --duration-seconds 120 --fast-per-second 4 --slow-per-second 1 --artifact-dir <private-artifact-dir> --output <private-benchmark.json>
node scripts/speech-detection/check-acceptance.mjs --manifest <private-manifest> --review-evidence <private-review.json> --detector <detector.json> --baseline <baseline-list.json> --candidate <candidate-list.json> --benchmark <benchmark.json> --output <private-comparison.json>
```

Each batch list is a JSON array of report paths, relative to the list file or
absolute. Include every holdout case three times in both fast and slow phases.
The benchmark measures a fixed alternating speech/nonspeech two-second schedule,
120 seconds detector-off and 120 seconds mixed load, then 0.3/2/10/60/180-second
buckets and ten simultaneous jobs. Buckets start with a ready worker per phase
and recover readiness after a timeout so the next bucket does not measure a
previous bucket's cooldown. Those recovery times are excluded from assessment
latencies and worker starts are reported. Steady load retains ordinary production
cooldown/restart behavior. RSS is sampled every 20 ms for the whole process tree,
including the child detector; overhead is steady peak minus detector-off peak
before duration-bucket measurements. Unsupported process-tree measurement remains
unknown and cannot pass resource acceptance. Resource quotas come from
cgroup v1/v2 files; absent quota evidence remains unknown. Successful assessment
p95 and all-outcome p95 are separate so fast failures cannot look healthy. Raw rows retain the
scheduled phase, control, sequence and bucket repetition. The checker validates
expected counts and recomputes availability, p95, unavailable/overflow counts and
resource differences from those rows and measured RSS/event-loop inputs. Edited
or missing summaries/rows cannot satisfy machine acceptance. A short producer
smoke may check schema compatibility, but a run below 120 seconds is incomplete
for release acceptance. Historical reports missing the strengthened metadata stay
historical; never retrofit invented execution identity into them.

Acceptance exits nonzero for missing/mismatched evidence or a failed gate:
verified speech rejection, less than 50% rejection of baseline-admitted nonspeech,
increased WER, genuine-speech empty-output rate or nonspeech false-positive rate,
warm p95 beyond the phase deadlines, steady availability below 95%, overhead at
least 128 MiB, added event-loop p95 at least 20 ms, or missing fail-open burst
behavior. Quality gates apply to each phase and their aggregate. Quiet/short
speech and families are reported separately. Savings never override failed
quality. Provider-work checks require complete budgets and exact per-row submitted
seconds, bounded phase request counts, zero-work empty skips, and consistent
production assessments/admissions. Verified-speech nonspeech assessments in any
candidate phase/repetition fail even if the baseline transcript was already empty.
The report distinguishes `pass`, `fail` and `incomplete`, raw numerators
and denominators, unique clips and repeated attempts, absolute and relative
changes, and attestations from machine checks. Undefined relative changes and
unverified dollar amounts are `null`. Pipeline provenance retains source hashes,
ASR model, mode, phase, selection and repetitions, plus prompt/config hashes without
prompt content. Detector, benchmark and pipeline reports must have complete matching source,
compiled and build maps, including toolchain/config/lock identity and the actual
compiled loader. The checker also verifies the selected-case run fingerprint.
Hashes associate bytes and expose mismatches; they do not authenticate execution,
measurements, human review or untouched-holdout claims.
A machine pass still requires review of the
report and its interpretation before promotion.

### Matching internal metrics

Use existing private Prometheus/Grafana access. Record exact UTC start/end,
mode-at-meeting-start, runtime/image/policy, phase, traffic composition and captured
recording volume for each window. Newly selected mode applies to new meetings;
active meetings retain their captured setting. Compare equal windows or normalize
by captured audio minutes, never by the shrinking submitted-audio denominator.
For a chosen range such as `[1h]`, use:

```promql
sum by (mode, phase) (increase(chronote_speech_detection_provider_submissions_total[1h]))
/ on (mode) group_left
(sum by (mode) (increase(chronote_speech_detection_captured_audio_seconds_total[1h])) / 60)

sum by (mode, phase) (increase(chronote_speech_detection_submitted_audio_seconds_total[1h]))
/ on (mode) group_left
(sum by (mode) (increase(chronote_speech_detection_captured_audio_seconds_total[1h])) / 60)

sum by (mode, phase, kind, reason) (increase(chronote_speech_detection_assessments_total[1h]))
sum by (mode, phase, outcome) (increase(chronote_speech_detection_snippet_outcomes_total[1h]))
sum by (phase) (increase(chronote_speech_detection_queue_saturation_total[1h]))
sum(increase(chronote_speech_detection_worker_restarts_total[1h]))
histogram_quantile(0.95, sum by (le, mode, phase) (rate(chronote_speech_detection_assessment_duration_seconds_bucket[1h])))
histogram_quantile(0.95, sum by (le, mode, phase) (rate(chronote_speech_detection_end_to_end_duration_seconds_bucket[1h])))
```

SDK counters include voting and failed invocations, not hidden transport retries
or verified billable usage. Live text/shadow disagreement is not ground truth.
Keep live query output, runtime windows, provider rates and billing evidence in
private ops; no new analytics event or content-bearing metric label is needed.
