# Transcription eval runner

This CLI runs repeated transcription passes against a local audio clip and summarizes variance.

## Local file runs

```bash
yarn eval:transcription --file audio/sample.wav --runs 10 --language en --temperature 0
```

Optional flags:

- --prompt-file prompts/chronote-transcription-cleanup-chat.md
- --glossary-file docs/evals/transcription-glossary.txt
- --reference-file docs/evals/reference.txt
- --output docs/evals/run-2025-12-30.json

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

**Not usable as written (verified 2026-07-30).** No `transcription-eval` dataset
exists in the Langfuse project, and nothing in this repo creates or uploads one,
so this path fails on `dataset.get`. The project's one transcription dataset is
named `Transcription` and holds a single item with an empty `expectedOutput`, so
it will not grade either. Use the local file runs above until the seeding step
described in `docs/notes-eval.md` exists. The commands below record the intended
interface, not a working flow.

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
- WER is computed with word level Levenshtein distance.
- With --drop-prompt-like, prompt leakage outputs are counted but replaced with empty strings.
- Chat prompt files are reduced to their system messages before use.
- Bedrock evals require AWS S3 and ignore STORAGE_ENDPOINT overrides.
- Sample dataset payloads live in docs/evals/transcription-eval.dataset.json.
