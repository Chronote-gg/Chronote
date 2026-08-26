# Live Voice Agent (Text Gate + TTS) – Dec 18, 2025

## Current behavior

- Gate model (`gpt-5-mini` by default) returns **{ respond: boolean }** only. No fallback model.
- Responder model (configurable; currently gpt-5.1 class) generates the reply text.
- Thinking cue: soft multi-drop sound, looped while the responder is running; default interval 500ms between bursts.
- TTS (`gpt-4o-mini-tts`, voice `alloy` by default) streams into Discord voice; audio is mixed into the saved recording and appended to the transcript only after successful playback.
- Silence threshold for triggering the gate: 2s (constant for now). Bot is allowed to talk over others (no gate for “someone else is speaking”).

## Env knobs

- `LIVE_VOICE_MODE`: off | tts_gate
- `LIVE_VOICE_GATE_MODEL`: default gpt-5-mini
- `LIVE_VOICE_GATE_MAX_OUTPUT_TOKENS`: default 256
- `LIVE_VOICE_RESPONDER_MODEL`: default gpt-5.1-derived (configurable)
- `LIVE_VOICE_TTS_MODEL`: gpt-4o-mini-tts
- `LIVE_VOICE_TTS_VOICE`: alloy
- `LIVE_VOICE_THINKING_CUE`: true|false
- `LIVE_VOICE_THINKING_CUE_INTERVAL_MS`: default 500 (longer spacing between blips)

## Wiring (today)

1. Meeting join: connect with `selfMute: false`; set up AudioPlayer when `tts_gate` is enabled.
2. After each transcription segment, `maybeRespondLive` runs:
   - `shouldSpeak` → gate (small context)
   - optional looping thinking cue
   - `generateReply` → responder (richer context planned)
   - `streamTtsToDiscord` → plays audio, tees PCM into recording; on success, appends bot line to transcript.
3. Bot output is saved only on successful playback.

## Outstanding / follow-ups

- Context: expand responder context (longer window of current meeting + selected past meetings); begin lightweight retrieval without vector DB.
- Audio polish: optional mixer to avoid interlaced voices; consider shorter gate window when we revisit turn-taking.
- UX: optional “thinking cue” config per guild/channel; expose model choices via config/env.
- Performance: optional cheap gate model with richer responder model (already scaffolded by separate envs).
- Future: real-time voice-to-voice (Realtime API) once stable.\*\*\*
