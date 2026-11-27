# ADR-20261027: Speech detector process isolation

Status: Accepted for implementation. Final image resource acceptance remains required. Detection stays off pending separate quality acceptance and activation approval.

Date: 2026-10-27. Revised: 2026-10-28, 2026-11-27.

Owners: Audio pipeline

## Outcome and scope

Keep detector failures isolated from recording while meeting the existing resource budget. Preserve the Silero model, whole-clip policy, queue, deadlines, original audio and default-off behavior. Replace the WASM backend with the same version of native ONNX Runtime, and use a glibc-based Node image required by its official CPU binaries.

This is an implementation decision within PR403. It does not authorize deployment or speech rejection.

## Evidence and decision

The original worker thread could terminate the recorder on a process-level failure. One child process contains that failure. Typed replies, owned input copies, bounded queuing, deadlines, restart cooldown and hard termination remain in place.

The WASM implementation exceeded memory limits. Direct optimized compilation with `--no-liftoff` avoided retaining both compilation tiers and restored steady availability, but its unchanged constrained benchmark still used about 194 MiB of additional process-tree RSS. Heap caps, compiler settings and asset-loading probes did not meet the 128 MiB gate. Those unsuccessful probe settings were not adopted.

Use `onnxruntime-node@1.30.0` with the existing Silero 6.2.1 bytes. Run one sequential CPU session with one intra-op and inter-op thread, CPU arena and memory-pattern reuse disabled. Bound the compiled child's V8 heap to 16 MiB old space and 1 MiB semi-space. Bound glibc allocator arenas to one in that child. Source-mode ts-node execution needs a larger heap and is not the production resource-test path.

A disposable native adapter passed the unchanged 0.5 CPU / 1 GiB benchmark: 600/600 steady assessments, fast/slow p95 latency of 7.43/8.25 ms and 125.48 MiB process-tree RSS overhead. That run had no allocator-arena override and left only 2.52 MiB below the limit. A separate arena-bound diagnostic was lower, but used a different baseline method and is not final acceptance. Repeat the complete original benchmark against the implemented production image and verified assets before calling the runtime accepted.

Official native binaries require glibc. Change the image from Node 24.22.1 Alpine to Node 24.22.1 Debian Bookworm slim, with equivalent build tools and FFmpeg. Skip the optional CUDA installer; the CPU binaries are bundled. Keep exact package/version, platform binary size/hash checks and offline startup. Update the engine identity in the policy fingerprint so prior WASM coverage cannot be reused.

## Behavior and quality limits

Positive speech may return after the existing two-frame criterion. Nonspeech requires a complete scan. Uncertain, unavailable, aborted or failed assessments continue to transcription. Detector failure must not stop recording or remove original audio.

All nine controlled native fixtures retained classification and deterministic recurrent-state reset. Silence and click controls matched the saved Python results exactly; the tone probability differed by about 8.94e-8. This is not bit-exact parity across backends or proof of real Discord transcript quality. Do not change classification thresholds or relax existing numeric test tolerances to conceal a difference. Human-reviewed, family-separated quality evidence and matched provider replay remain separate activation gates.

## Lifecycle and resource boundaries

Register parent-disconnection handling before model initialization. A responsive child exits immediately on owner loss; the owner kills a stuck child on timeout. Revised 2026-11-27: killing the child on every missed deadline looped under CPU load, leaving the detector unavailable for most of each busy period. The policy is now:

1. Each job has one budget from enqueue (500 ms fast, 1500 ms slow); no caller waits longer. An expired queued job fails as `timeout` and is never dispatched; a full queue drops the job with the least budget left (an infeasible one whenever any is queued) as `queue_full` to admit the new one.
2. The queue is served earliest deadline first among jobs that can still finish if the next inference takes as long as the last one, so live fast jobs are not starved behind slow work with slack; with none feasible the latest deadline runs as the best chance and refreshes the estimate.
3. A running job past its budget fails alone; the child keeps its slot until the late reply, which is dropped by id.
4. Each phase has its own breaker, judged on the child's inference time (dispatch to reply) against that phase's budget; queue time never counts. Two slow inferences in a row open it: that phase's queued jobs and new work get `not_ready`, the other phase is unaffected.
5. The window starts at the reply and grows 5, 10, 20, then 30 s per consecutive reopening. One probe per phase follows; in time resets everything, slow reopens.
6. Only an inference running 10 s past dispatch retires the child (30 s cooldown); retirement also resets both breakers.

Regimes. A single slow inference fails that job (and queued jobs whose own budget passed) without opening a breaker. At 0.3 s inferences nothing opens even at 3 arrivals a second; fast jobs that wait too long time out on queue time alone. At 0.6 s every fast inference misses, so the fast breaker opens and probes about every 30 s while slow work keeps succeeding. At 2 s or 5 s both phases miss; each wastes two inferences, then probes once per window, so the steady worst case is two probes per about 30 s: about 4 / 34 s (12 percent of a core) at 2 s and 10 / 40 s (25 percent) at 5 s. The old kill-and-cooldown spent a 1.6 to 5 s model load plus one inference per 30 s cooldown, about 7 to 18 percent, and failed every queued job each time.

Known limits. While a slow inference holds the slot, newly queued work waits out its budget before the breaker can judge it. Recovery assesses in the slow phase with the same 1500 ms budget, so under live load it may be assessed unavailable and transcribed unguarded.

Count the parent's and every descendant's RSS. Process isolation is a failure boundary, not an independent memory allocation. Keep the original workload, CPU/memory limits, phase deadlines and acceptance thresholds. Missing resource evidence remains unknown and fails acceptance.

## Tradeoffs and alternatives

The native backend requires a larger glibc image, platform-specific integrity checks and verification of the application's other native dependencies. Full builds, packaged inference, crash/lifecycle regressions, controlled numerical checks and the complete resource benchmark must cover the final bytes.

Retaining the WASM implementation preserves image compatibility but has not met memory acceptance. A custom musl native build or compatibility layer adds another unsupported packaging path. A sidecar or remote detector adds deployment and communication changes without removing the resource-accounting requirement. An independent watchdog is only needed if this detector is later supported outside the production container lifecycle.

## References

See `docs/superpowers/specs/2026-10-13-speech-detection-design.md` for the admission contract and `docs/transcription-eval.md` for the unchanged acceptance procedure. Historical failed measurements remain evidence for the superseded runtimes.
