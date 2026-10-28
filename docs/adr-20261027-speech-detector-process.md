# ADR-20261027: Speech detector process isolation

Status: Accepted for PR implementation. Runtime and quality acceptance remain separate from activation.

Date: 2026-10-27

Owners: Audio pipeline

## Context

The experimental detector used a worker thread inside the recording bot's Node
process. A process-level failure in that worker could terminate the recorder.
The pinned WASM engine also retained substantial compilation memory during early
inference. The original resource benchmark failed; increasing its limits would
hide the problem.

## Decision

Run the existing detector worker as one local child process, retaining the same
model, engine, policy, input conversion and single-threaded WASM execution.
Start that child with the explicit V8 flag `--no-liftoff`, which avoids retaining
baseline and optimized WASM compilation tiers. Do not pass arbitrary parent
execution flags to the child.

Keep the existing bounded queue, deadlines, failure handling and restart
cooldown. A crash, malformed response, timeout or unavailable worker continues
through transcription. Register parent-disconnection handling before model
initialization. A responsive child exits immediately on owner loss; the owner
kills a stuck child on timeout. Disabled detection must not start it.

Count the parent's and descendants' RSS when evaluating overhead. A child process
is a failure boundary, not an independent CPU or memory allocation. Keep the
original 0.5 CPU, 1 GiB container test and acceptance thresholds.

## Consequences

Detector failure can be isolated from recording, at the cost of IPC copies and a
second Node runtime. Warmup occurs outside assessment deadlines. Resource and
latency acceptance must use the actual production transport and executable.

Production container exit reaps descendants, including a child stuck in native
code. Outside that container, a synchronous native hang cannot process an IPC
disconnect after its owner dies. This implementation adds no independent
watchdog for that unsupported lifecycle.

This change does not enable speech rejection, prove production request savings,
change snippet boundaries or replace the missing human-reviewed quality holdout.
Default mode remains off. Existing recordings are retained.

## Alternatives considered

Retaining the worker thread cannot apply this V8 flag through Worker execArgv and
retains the process failure boundary. A Fargate sidecar or separate service adds
deployment, resource and communication changes before the local-process option
has been measured. Native ONNX or another detector changes the engine or model
and needs a separate quality and compatibility decision.

## Notes

See `docs/superpowers/specs/2026-10-13-speech-detection-design.md` and
`docs/transcription-eval.md` for the admission contract and acceptance procedure.
Historical failed measurements remain valid evidence for the earlier runtime.
