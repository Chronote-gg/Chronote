# ADR-20260107: Chronote Desktop Recorder (Tauri)

Status: Accepted
Date: 2026-01-07
Owners: Desktop recorder, Voice/Transcription

## Context

- Discord does not expose a supported way for bots to capture Go Live or local system audio.
- Chronote already has personal meeting ownership, signed upload forms, transcription, notes generation, and Notion export paths.
- A local client must not hold OpenAI credentials or automate a Discord user client.
- Windows is the first supported desktop target because WASAPI exposes microphone and system-output capture primitives.
- Signed auto-updates are useful, but they require release key custody and a stable packaging pipeline.

## Decision

1. Build Chronote Desktop as a Tauri v2 app under `apps/desktop`.
2. Use external browser sign-in with a localhost loopback callback, PKCE, and Chronote-issued desktop bearer/refresh tokens.
3. Store desktop tokens in the operating-system keyring. The desktop app never stores OpenAI credentials.
4. Capture microphone and system output as separate Windows audio sources in v1.
5. Label microphone audio as **Me** and system output as **System/Other** in v1. Speaker diarization and app/process attribution are later work.
6. Upload each captured source through Chronote signed S3 POST forms, then complete one personal recording upload job.
7. Process desktop recordings in the existing personal meeting pipeline by transcribing each source separately, preserving source labels, mixing a normalized playback artifact, generating notes, and saving the result in **My Meetings**.
8. Keep the capture backend isolated so process-scoped loopback, echo cancellation, macOS, and Linux implementations can be added later.
9. Start with manual/dev installer notes. Signed production auto-update can follow once release signing custody and artifact hosting are ready.

## Consequences

Positive:

- Users can create personal Chronote meetings from local computer audio without joining a Discord voice channel.
- Existing Chronote upload, transcription, notes, search, sharing, and Notion export behavior is reused instead of adding a separate desktop-only pipeline.
- Separating microphone and system output gives notes generation clearer speaker labels than a single mixed recording.
- Browser-based OAuth keeps desktop auth public-client compliant and avoids embedded Discord credentials.

Costs and risks:

- Windows-only v1 delays macOS/Linux support.
- System output can include remote participants or notification sounds, so transcript contamination is still possible until app/process isolation or echo controls are added.
- WASAPI device behavior varies by hardware and drivers, requiring manual Windows smoke testing.
- Desktop packaging and signed updates remain separate release work.

## Alternatives Considered

1. Electron plus native Node audio modules: broader ecosystem, but a larger runtime and more attack surface.
2. Pure Rust plus WinUI: smaller UI stack, but slower product iteration and less reuse of existing React patterns.
3. OBS or virtual audio cable requirement: avoids custom capture code, but creates too much user setup friction.
4. Bot-only recording: cannot capture local system audio and does not solve the desktop recording need.
5. Streaming audio frames directly to Chronote: useful later for live workflows, but signed upload reuse is smaller and safer for v1.

## Notes

- The desktop app is a Chronote client, not a Discord client.
- Desktop tokens currently use the existing OAuth storage table with desktop-specific key prefixes.
- Process-scoped loopback, echo cancellation, signed auto-update, and cross-platform capture should be separate follow-up decisions when implemented.
- Desktop productization, release CI/CD, native smoke testing, signing, and update gates are tracked in `docs/desktop-productization.md` and issue #249.
