# Hallucination audit 2026-02-10

Meeting

- ID: 3837e4e0-64e9-44ba-b5de-c3a6849832d6
- Window: 2026-02-09 19:00-20:00 EST (UTC-05:00)
- Traces: 2052
- Full raw artifacts: archived in audit PR #116

Classification counts

- Hallucinated: 379
- Legit: 495
- Unknown: 1178

Reason counts (top)

- Hallucinated: prompt_echo_detected 300, contains_vket 79
- Unknown: no_output 1031, mixed_signals 124, quiet_audio 17

Syllables per second (SPS)

- SPS is present for all traces in this meeting.
- Guard logic today: audio <= 3s, wordCount >= 4, syllableCount >= 8, sps > 7.
- Max legit SPS in short clips (audio <= 3s, non-empty output): 5.217.
- Short clip SPS > 7 with non-empty output:
  - Hallucinated: 0
  - Legit: 0
  - Unknown: 1
- The only unknown short clip above 7 SPS was "Hey, everyone!" (0.48s, SPS 8.33). It does not meet min word or syllable counts so the guard does not fire.
- Max legit SPS overall: 11.36 in a 9.86s clip with repeated "No". This does not hit the rate mismatch guard because audio > 3s.

Audio mean dB (full coverage)

- Computed mean dB for 1322 of 1322 unique snippet clips.
- Hallucinated mean dB (n=367): -61.25, stdev 15.76, min -91.0, max -22.4
- Legit mean dB (n=462): -30.35, stdev 8.41, min -67.3, max -13.3
- Unknown mean dB (n=1145): -65.78, stdev 16.89, min -91.0, max -14.2

Mean dB threshold sensitivity (all clips, using mean dB)

- Threshold -45: hallucinated 308/367, legit 23/462, unknown 982/1145
- Threshold -50: hallucinated 262/367, legit 15/462, unknown 921/1145
- Threshold -55: hallucinated 229/367, legit 12/462, unknown 831/1145
- Threshold -60: hallucinated 201/367, legit 4/462, unknown 752/1145

Mean dB threshold sensitivity (non-empty output only)

- Threshold -45: hallucinated 55/73, legit 23/462, unknown 60/135
- Threshold -50: hallucinated 40/73, legit 15/462, unknown 49/135
- Threshold -55: hallucinated 35/73, legit 12/462, unknown 41/135
- Threshold -60: hallucinated 30/73, legit 4/462, unknown 33/135

Notes

- Mean dB is not the same as peak dB. Current noise gate peak default is -45 dBFS and hard silence is -60 dBFS.
- This audit uses Langfuse trace metadata plus audio media; no production behavior changes are included here.

Follow-ups

- Vote transcription: run multiple transcriptions on the same snippet, for example prompt and no-prompt, and select the best with an arbiter.
- Gate the vote path to keep cost low, for example only when prompt echo triggers, low logprob confidence, or large divergence between fast and slow transcripts.
- Consider an arbiter that uses logprob stats and anti-repetition guidance, not just raw length.
