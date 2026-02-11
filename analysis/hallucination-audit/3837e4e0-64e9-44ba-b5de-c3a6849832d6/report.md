Meeting: Nonprofit Process and Media Consent
Meeting ID: 3837e4e0-64e9-44ba-b5de-c3a6849832d6
Guild ID: 480695542155051010
Channel ID: 1162985500995493959
Start timestamp: 2026-02-09T23:47:40.876Z
Duration seconds: 3441

Storage references

- Transcript S3 key: 480695542155051010/1162985500995493959_3837e4e0-64e9-44ba-b5de-c3a6849832d6_2026-02-09T23-47-40.876Z/transcript.json
- Audio S3 key: 480695542155051010/1162985500995493959_3837e4e0-64e9-44ba-b5de-c3a6849832d6_2026-02-09T23-47-40.876Z/audio_combined.mp3
- Chat S3 key: 480695542155051010/1162985500995493959_3837e4e0-64e9-44ba-b5de-c3a6849832d6_2026-02-09T23-47-40.876Z/chat.json

Langfuse trace window

- Window: 2026-02-09 19:00-20:00 EST (UTC-05:00)
- Base URL: https://us.cloud.langfuse.com
- Total transcription traces: 2052

Classification counts

- Hallucinated: 379
- Legit: 495
- Unknown: 1178

Hallucination reasons (top)

- prompt_echo_detected: 300
- contains_vket: 79
  Unknown reasons (top)

- no_output: 1031
- mixed_signals: 124
- quiet_audio: 17
- contains_timestamp: 5
- contains_bot_name: 4
- contains_bracket_timestamp: 1
  Notes

- RecordingTranscript table lookup returned no item for this meeting ID.
- Noise gate metrics include peakDbfs and noiseFloorDbfs, there is no stored average dB in Langfuse metadata.
- Prompt echo metrics are included per trace when available.

Audio mean volume

- Computed mean dB for 1322 of 1322 unique snippet clips.
- Hallucinated mean dB (n=367): -61.25 (min -91.0, max -22.4, stdev 15.76)
- Legit mean dB (n=462): -30.35 (min -67.3, max -13.3, stdev 8.41)
- Unknown mean dB (n=1145): -65.78 (min -91.0, max -14.2, stdev 16.89)

Full meeting transcription

- Audio downloaded from S3 and split into 6 chunks (10 min each) for transcription.
- Transcript written to full_transcript.txt and full_transcript_segments.json.

Full transcript alignment (threshold 0.85)

- Hallucinated: 379
- Legit: 495
- Unknown: 1178

Full transcript match score stats

- Legit (n=452): mean 0.709, min 0.195, max 1.0
- Unknown (n=197): mean 0.541, min 0.211, max 1.0

Langfuse dataset sample

- Dataset name: hallucination-audit-20260209
- Sample size: 100 (40 hallucinated, 40 unknown, 20 legit)

Artifacts

- analysis/hallucination-audit/run_audit.py
- analysis/hallucination-audit/raw_traces_2026-02-09_1900-2000.json
- analysis/hallucination-audit/raw_traces_2026-02-10_1900-2000.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/summary.md
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/report.md
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_raw.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified.csv
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_hallucinated.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_legit.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_unknown.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/reason_counts.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/duplicate_groups.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/near_duplicate_groups.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/meeting_history_query.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/meeting_history_match.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/recording_transcript.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/full_audio_metadata.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/full_transcript.txt
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/full_transcript_segments.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified_with_audio.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified_with_audio.csv
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/audio_volume_metrics.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified_with_audio_and_full.json
- analysis/hallucination-audit/3837e4e0-64e9-44ba-b5de-c3a6849832d6/transcriptions_classified_with_audio_and_full.csv
