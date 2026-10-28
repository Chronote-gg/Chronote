# Synthetic runtime controls

These nine WAVs are copied byte-for-byte from the synthetic-transcription-controls-v1 corpus generated at 2026-10-13T01:16:03.039Z. Their SHA-256 values are in manifest.json. No production recording, participant identifier or private meeting content is included. Task 1 made no synthesis, ASR or other paid provider calls.

The original generation used eight gpt-4o-mini-tts requests with the coral voice, recorded in generation.json. This subset contains two independent synthesis inputs: `Yes.` and `The Workshop.`. Those texts establish the speech references; they are not recognizer output. Normal, quiet (-52 dBFS peak) and Opus round-trip variants share their synthesis reference. Silence, tone and click are generated signals with no speech. Synthetic speech does not establish human-recording quality.

Source preparation is the repository's `scripts/evals/prepare-transcription-corpus.ts`; inspect its saved corpus and generation evidence if regenerating. This checked-in subset retains the source WAV hashes and labels. The Opus controls are decoded WAVs, not original Opus packets.

python-reference.json is the corresponding saved offline Silero v6.2.1 result (ONNX Runtime 1.31.0, NumPy 2.5.1), with -20 dBFS peak normalization and maximum gain 100. These are comparison references for later detector work, not acceptance claims for real Discord recordings. The Task 1 smoke checks packaging and ten silence frames only. Later tasks must execute these fixtures through the production detector.
