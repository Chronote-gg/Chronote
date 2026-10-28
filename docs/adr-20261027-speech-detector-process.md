# ADR-20261027: Speech detector process isolation

Status: Accepted for implementation. Final image resource acceptance remains required. Detection stays off pending separate quality acceptance and activation approval.

Date: 2026-10-27. Revised: 2026-10-28.

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

Register parent-disconnection handling before model initialization. A responsive child exits immediately on owner loss; the owner kills a stuck child on timeout. Production container exit reaps descendants, including a child synchronously stuck in native code. Outside that container, a synchronous hang cannot process IPC disconnect after owner death. No independent watchdog is included for that unsupported lifecycle.

Count the parent's and every descendant's RSS. Process isolation is a failure boundary, not an independent memory allocation. Keep the original workload, CPU/memory limits, phase deadlines and acceptance thresholds. Missing resource evidence remains unknown and fails acceptance.

## Tradeoffs and alternatives

The native backend requires a larger glibc image, platform-specific integrity checks and verification of the application's other native dependencies. Full builds, packaged inference, crash/lifecycle regressions, controlled numerical checks and the complete resource benchmark must cover the final bytes.

Retaining the WASM implementation preserves image compatibility but has not met memory acceptance. A custom musl native build or compatibility layer adds another unsupported packaging path. A sidecar or remote detector adds deployment and communication changes without removing the resource-accounting requirement. An independent watchdog is only needed if this detector is later supported outside the production container lifecycle.

## References

See `docs/superpowers/specs/2026-10-13-speech-detection-design.md` for the admission contract and `docs/transcription-eval.md` for the unchanged acceptance procedure. Historical failed measurements remain evidence for the superseded runtimes.
