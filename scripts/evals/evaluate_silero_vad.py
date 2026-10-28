"""Offline candidate gate, never imported by the production bot.

Uses the versioned Silero ONNX model's documented 512-sample / 64-context
protocol. Model state resets per clip. Outputs bind decisions to audio hashes.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import wave

import numpy as np
import onnxruntime as ort

MODEL_SHA256 = "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"


def detect(samples, session, threshold, min_frames):
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    probabilities = []
    for offset in range(0, len(samples), 512):
        chunk = samples[offset:offset + 512]
        chunk = np.pad(chunk, (0, 512 - len(chunk))).reshape(1, 512)
        tensor = np.concatenate((context, chunk), axis=1)
        probability, state = session.run(None, {
            "input": tensor, "state": state, "sr": np.array(16000, dtype=np.int64)
        })
        probabilities.append(float(probability.reshape(-1)[0]))
        context = tensor[:, -64:]
    longest = current = 0
    for value in probabilities:
        current = current + 1 if value >= threshold else 0
        longest = max(longest, current)
    return {
        "shouldTranscribe": longest >= min_frames,
        "peakSpeechProbability": max(probabilities, default=0),
        "maxConsecutiveSpeechFrames": longest,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--min-frames", type=int, default=2)
    parser.add_argument("--normalize-dbfs", type=float)
    parser.add_argument("--artifact-dir", default=".cache/transcription-eval")
    args = parser.parse_args()
    if not 0 < args.threshold < 1 or args.min_frames < 1:
        raise ValueError("Invalid VAD threshold or frame count")
    if args.normalize_dbfs is not None and not -60 <= args.normalize_dbfs <= -10:
        raise ValueError("Normalization target must be between -60 and -10 dBFS")
    model = Path(args.model)
    if hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError("Silero v6.2.1 model hash does not match")
    manifest = Path(args.manifest).resolve()
    corpus = json.loads(manifest.read_text(encoding="utf-8"))
    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
    results = []
    for item in corpus["cases"]:
        audio = manifest.parent / item["file"]
        if hashlib.sha256(audio.read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError("Audio hash changed for " + item["id"])
        # Corpus preparation already converts to production's 16 kHz WAV.
        with wave.open(str(audio), "rb") as recording:
            if recording.getframerate() != 16000 or recording.getsampwidth() != 2:
                raise ValueError("VAD experiment requires 16 kHz s16le WAV")
            channels = recording.getnchannels()
            samples = np.frombuffer(recording.readframes(recording.getnframes()), dtype="<i2")
            samples = samples.astype(np.float32).reshape(-1, channels).mean(axis=1) / 32768
        gain = 1.0
        if args.normalize_dbfs is not None:
            peak = np.max(np.abs(samples), initial=0)
            if peak > 0:
                # Limit amplification to 40 dB; no attempt to normalize silence.
                gain = min(100.0, 10 ** (args.normalize_dbfs / 20) / float(peak))
                samples = samples * gain
        started = time.perf_counter()
        result = detect(samples, session, args.threshold, args.min_frames)
        result.update(id=item["id"], sha256=item["sha256"], gain=gain,
                      durationMs=(time.perf_counter() - started) * 1000)
        results.append(result)
    cache = Path(args.artifact_dir).resolve()
    output = Path(args.output).resolve()
    if not output.is_relative_to(cache):
        raise ValueError("VAD results must remain in the selected artifact directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "version": 1, "detector": "silero-v6.2.1-onnx", "modelSha256": MODEL_SHA256,
        "runtimeVersion": ort.__version__, "numpyVersion": np.__version__,
        "parameters": {"threshold": args.threshold, "minFrames": args.min_frames,
                       "normalizeDbfs": args.normalize_dbfs, "maxGain": 100},
        "cases": results,
    }, indent=2), encoding="utf-8")
    dropped = [r["id"] for r in results if not r["shouldTranscribe"]]
    print(json.dumps({"clips": len(results), "skipped": len(dropped), "skippedIds": dropped}))
    print("Local VAD report: " + str(output))


if __name__ == "__main__":
    main()
