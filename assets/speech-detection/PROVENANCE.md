# Speech runtime assets

The Silero v6.2.1 ONNX model is checked in here with its upstream MIT license. Its SHA-256 is pinned in manifest.json and the smoke script. The cached model and a fresh download from the exact upstream tag both matched that pin on October 13, 2026.

The exact `onnxruntime-node@1.30.0` package supplies the local CPU runtime. `manifest.json` records its registry tarball integrity, four executed JavaScript modules and platform-specific native bindings and libraries, with byte lengths and SHA-256 hashes. Inventories cover the platforms bundled upstream: Linux x64/arm64, Windows x64/arm64 and macOS arm64. The worker selects the current platform and hashes its files through streams before importing the engine. Unsupported platforms and missing or corrupt assets fail open. Files remain in `node_modules/onnxruntime-node`, installed from `yarn.lock`; inference downloads no runtime or model. Install with `ONNXRUNTIME_NODE_INSTALL=skip` to use the packaged CPU binaries without the optional CUDA download. The upstream ONNX Runtime MIT license is included here because the published npm package does not include a LICENSE file at its root.

Run the packaging smoke from the repository root:

```sh
node scripts/speech-detection/runtime-smoke.mjs --runtime-dir node_modules --model assets/speech-detection/silero-v6.2.1.onnx
```

The smoke verifies model and runtime file hashes before importing the engine, selects sequential CPU inference with intra/inter threads set to one, CPU arena disabled and memory pattern disabled, and runs ten silence frames with the upstream 16 kHz / 512-sample / 64-context protocol and [2,1,128] recurrent state. It checks finite probabilities, the silence ceiling and finite state values. This is engine compatibility evidence; worker budgets and speech classification are later checkpoints.

Primary sources: [versioned model](https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/data/silero_vad.onnx), [Silero protocol](https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/utils_vad.py), [Silero license](https://github.com/snakers4/silero-vad/blob/v6.2.1/LICENSE), [ONNX Runtime license](https://github.com/microsoft/onnxruntime/blob/v1.30.0/LICENSE), and [versioned native binding](https://github.com/microsoft/onnxruntime/tree/v1.30.0/js/node).
