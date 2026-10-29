# Transcription quality evals, October 13, 2026

The local eval runner now exercises the production audio conversion, noise gate, transcript guards, and candidate selection. The first synthetic runs reproduced dictionary hallucinations on nonspeech and exposed a separate false rejection of real dictionary phrases. An experimental speech gate eliminated those errors on this small corpus. It is not a production change.

## Implemented

- `eval:transcription --manifest` supports raw provider, pipeline, and preflight modes. Fast and slow selection are separate runs.
- Each clip requires a content hash, an explicit speech/nonspeech/unreviewed label, and label provenance. Silence means the expected output is empty; missing ground truth means unscored.
- Scores cover every repetition, including unwanted output, dropped speech, normalized exact match, and word error rate. Unicode words remain intact. The legacy file and Langfuse dataset evaluators also grade every repetition and accept an empty reference.
- Results retain raw candidates, suppression flags, voting scores, provider usage, actual request attempts, submitted audio duration, policy, and per-run latency. Future runs also record source-file hashes and Node version. Retries are disabled in the corpus runner so request budgets count actual attempts. Errors remain unscored failures, with a nonzero exit code.
- Artifacts stay in an ignored local directory and tracing is disabled for corpus runs. No production audio was accessed or replayed in these experiments.
- Two production-code corrections have regression coverage: punctuation-only output is suppressed, and slow-pass voting can reject both candidates when neither meets the existing quality floor. Both requests remain accounted for. These changes are local and have not been deployed.

The production amplitude gate and prompt-echo policy are otherwise unchanged. Silero and the policy that disables prompt echo exist only in the eval experiment.

## Observed results

The corpus has 32 synthetic clips: 8 negatives (digital silence, low noise, tones, clicks) and 24 speech variants from 8 short TTS phrases. Speech variants include normal volume, a peak of -52 dBFS, and an Opus round trip. References come from independent synthesis inputs, not from the recognizer's outputs. The prompt contains generic dictionary terms and event-planning context. The model was `gpt-4o-transcribe`, language `en`, temperature 0.

Each configuration ran all 32 clips three times, for 96 scored attempts. Runs completed without provider failures between 01:17 and 01:23 UTC on October 13.

| Configuration                                      | Unwanted text on 24 nonspeech attempts | Dropped speech out of 72 | Requests | Submitted seconds |
| -------------------------------------------------- | -------------------------------------: | -----------------------: | -------: | ----------------: |
| Raw provider with dictionary prompt                |                                     24 |                        0 |       96 |            205.35 |
| Pipeline, fast, including the two corrections      |                                      6 |                        9 |       84 |            175.35 |
| Pipeline, slow, including the two corrections      |                                      5 |                        0 |      100 |            204.70 |
| Experimental normalized VAD, fast, prompt echo off |                                      0 |                        0 |       72 |            145.35 |

All speech references matched after normalization in the raw provider, slow pipeline, and experimental runs. The fast pipeline dropped all nine variants/repetitions of "The Workshop" because that phrase is also in the dictionary prompt. The slow pipeline recovered them through a no-prompt retry. Its 100 requests illustrate why post-request suppression and retries do not automatically reduce spending.

The experimental configuration made 28 fewer requests than the slow pipeline, a 28% reduction on this corpus. It submitted 29% less audio. These are observed request and duration reductions, not a production cost forecast. Dollar cost remains unpriced; response usage is retained in the local JSON files. Corpus preparation separately used 8 speech synthesis requests. The four transcription runs used 352 requests total.

The native-volume Silero trial rejected all negatives but also rejected `yes-quiet`, `vrchat-quiet`, and `no-quiet`. A second trial used a -20 dBFS peak target, capped at 40 dB of gain. It accepted all 24 speech clips and rejected all 8 negatives. Detection used a 0.5 probability threshold and at least two consecutive 32 ms frames. This is a whole-clip gate; it neither trims nor segments the submitted speech.

The ONNX model is [Silero v6.2.1](https://github.com/snakers4/silero-vad/tree/v6.2.1), with SHA-256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`. The local wrapper follows its [documented ONNX state and context protocol](https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/utils_vad.py). The experiment used ONNX Runtime 1.31.0 and NumPy 2.5.1. These Python dependencies are optional local eval tools and are not added to the bot runtime.

## Limits and next decision

This corpus is a diagnostic control set. It contains one synthetic voice, simple noise, and English references. It does not establish performance on real Discord microphones, overlapping voices, music with vocals, background television, laughter, breathing, clipped words, foreign-language speech, or rapidly repeated interjections. Both nominal tune and holdout splits were inspected while choosing the normalization variant, so neither is an independent release holdout.

The experiment changed two factors together, speech detection and prompt-echo policy. It cannot attribute every quality gain to one factor. The separate offline VAD comparison does establish its gate decisions on the saved clips. Latency in the pipeline results excludes corpus preparation, resampling, and offline VAD inference. Production CPU, memory, capture latency, and live revisions still need measurement.

The next useful step is a human-reviewed Discord corpus. Include verified nonspeech and quiet speech, dictionary names, short acknowledgments, overlapping voices, and any multilingual examples we intend to support. Keep all variants from the same recording in one split. Tune only on the development split and reserve a fresh holdout for the final comparison. Measure request avoidance and lost speech together. Investigate capture/chunking faults separately from provider and guard errors.

Production recordings and detailed provider evidence belong in the private `chronote-ops` workspace. Reading/listening for annotation and replaying recordings to a provider are separate steps. The private ops rules require authorization for production replay. The synthetic result supports trying the candidate on reviewed real clips; it does not yet support promoting the VAD or disabling prompt echo in production.

## Running the evals

Run from the product checkout. FFmpeg must be available. Provider and synthesis runs need the configured OpenAI key. Local runs can use mock configuration with OAuth and Langfuse tracing disabled; do not replace a real key with the dummy key in `mock.env.example`.

```powershell
# Generate negatives only. Add --speech for eight bounded TTS requests.
npm run eval:transcription:corpus -- --speech

# Substitute the printed manifest path. Select tune while iterating.
npm run eval:transcription -- --manifest <manifest.json> --mode preflight --runs 1 --split tune
npm run eval:transcription -- --manifest <manifest.json> --mode provider --runs 3 --max-requests 100 --split tune
npm run eval:transcription -- --manifest <manifest.json> --mode pipeline --pass-mode fast --runs 3 --max-requests 100 --split tune
npm run eval:transcription -- --manifest <manifest.json> --mode pipeline --pass-mode slow --runs 3 --max-requests 150 --split tune
```

`--policy` accepts validated JSON overrides for the existing gate/guard settings. `--prompt-file` replaces the corpus prompt. `--force` mirrors the production bypass of duration/noise gating and loudness suppression; prompt-echo behavior remains separately configurable. Compare configurations against the same audio hashes.

For real clips, create a version 1 manifest with `name`, `prompt`, and `cases`. A case has `id`, `file` relative to the manifest, `sha256`, `split` (`tune` or `holdout`), `tags`, and a label. A reviewed speech label is `{ "kind": "speech", "transcript": "Yes.", "provenance": "human-reviewed" }`. Reviewed nonspeech uses `{ "kind": "nonspeech", "provenance": "human-reviewed" }`; unreviewed clips use `{ "kind": "unreviewed" }` and are never graded. Review a label again when its audio hash changes.

Use `--artifact-dir D:/bench/chronote-ops/.cache/transcription-eval` for private recordings. That directory is ignored by the private repository. With `--output`, give an absolute path inside the selected artifact directory. Corpus runs never publish to Langfuse. Existing explicit Langfuse dataset mode remains available separately.

For the optional VAD experiment, install `scripts/evals/requirements-vad.txt` into an isolated environment. Download the versioned model from the upstream repository into the ignored cache; the script verifies its fixed hash before inference.

```powershell
python scripts/evals/evaluate_silero_vad.py --manifest <manifest.json> --model .cache/transcription-eval/silero-v6.2.1.onnx --normalize-dbfs -20 --output .cache/transcription-eval/vad.json
npm run eval:transcription -- --manifest <manifest.json> --mode pipeline --pass-mode fast --vad-report .cache/transcription-eval/vad.json --policy <policy.json> --runs 3 --max-requests 100 --split tune
```

The experimental policy used `{ "promptEchoEnabled": false }`. VAD decisions must match every selected case's audio hash. Treat a missing or stale decision as an error, not as permission to drop a clip.

## Local evidence and validation

The original synthetic corpus and unabridged results are in `.cache/transcription-eval/` in this worktree:

- `synthetic-Ej2Ai8/manifest.json` and `generation.json`
- `preflight-controls.json`
- `provider-controls.json`
- `pipeline-fast-controls.json` and `pipeline-slow-controls.json`
- `vad-native-controls.json` and `vad-normalized-controls.json`
- `vad-candidate-controls.json`

Validation passed: 98 tests across 20 suites covering audio capture, gates, selector, corpus labels/scoring, request budgets, terminal failures, final pass, and tracing attachment. TypeScript checks passed for the product and eval scripts. Scoped ESLint and formatting checks passed. The real API runs verified audio decoding and provider calls with the saved synthetic files. No deployment or real Discord quality acceptance has occurred.
