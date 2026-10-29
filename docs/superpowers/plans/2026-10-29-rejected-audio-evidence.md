# Rejected audio evidence implementation plan

> Execute inline using superpowers:executing-plans.

Goal: retain exact enforce-mode rejection provenance and provide one read-only operator command that extracts a bounded private listening batch.

Architecture: additive receipts in existing transcription checkpoints, captured through the shared live snippet wrapper. A standalone Node command validates an explicitly supplied meeting checkpoint and reads only referenced S3 objects, then writes numbered WAVs and a minimized manifest. Reuse installed AWS SDKs and PCM schemas.

Spec: approved one-time operator verification design in the owning chat. No UI, scheduler, production configuration, deployment, provider replay, new retention or model changes. Existing recordings remain authoritative.

## Tasks

- [x] Add receipt schema and live capture. Record exact PCM correspondence/hash/length, policy, enforce snapshot mode, phase and decision time. Checkpoint on skipped fast and slow requests even with no transcript. Record unavailable provenance explicitly. Preserve final outcome evidence in later checkpoints. Test legacy parsing, deduplication, both phases, final omission distinction and recording-safe failures.
- [x] Add an extraction command and operator instructions. Require explicit meeting identity and checkpoint pointer, account/region/bucket identity, read-only AWS access, bounded selection and fresh output directory. Verify manifest capture binding, every fetched object checksum/length and input hash. Extract up to ten unique rejected inputs and three passed transcript intervals, with optional same-piece context that never invents gap coverage. Report missing/ambiguous/legacy evidence as incomplete; never call replay a receipt. No original audio or transcripts in stdout or Git. Test exact multi-piece extraction, duplicates, wrong identities, missing/deleted/corrupt sources, safe output and old checkpoints.
- [x] Run focused tests, typecheck, formatting and relevant integration regressions. Review the final diff, fix material findings and record limits. No merge or deployment.

## Decisions

Use local checkpoint pointers exported by the existing private operator tools. The extractor uses the existing AWS credential chain in an authorized operator environment, checks STS account identity, and performs GetObject only. It does not discover meetings or provision credentials. Context is optional; exact clips remain playable when adjacent retained coverage is unavailable. Historical data without receipts remains unknown.

## Verification and limits

147 focused application tests passed, covering receipts, both live phases, checkpoints, snippet handling and recovery. Eight Node extraction tests passed; a small Jest wrapper includes them in the ordinary suite after the normal build. TypeScript and changed-file lint passed. Fresh-context review found an output-path containment edge case and optional-context failure handling; both were fixed and regression tested, then re-reviewed.

Ruling: use a manual Git worktree inside the task artifact folder because the native app rejected the product source folder as outside this chat's workspace. Preserve the shared checkout. Reuse the existing installed dependency tree read-only for local verification.

No production deployment, AWS media extraction, human listening, full-load benchmark or detector tuning was performed. The operator must obtain fresh authorized checkpoint pointers, honor deletion requests and use a private local output directory. Transcript controls are retained transcript intervals, not saved positive detector decisions.
