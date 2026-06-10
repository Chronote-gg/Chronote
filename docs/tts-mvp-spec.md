## Chat-to-Speech MVP Spec

### Summary

Add a chat-to-speech (TTS) feature that speaks every message typed in the voice-channel text chat during active meetings, plus a /say command for manual speech. The feature is gated to Basic/Pro, supports a server default and channel override, and allows per-user voice, spoken name, prefix, volume, and opt-out settings. Spoken chat is queued with Chronote live voice replies so audio never overlaps. During recorded meetings, spoken chat is included in the meeting recording and transcript. Outside recorded meetings, /say can start a TTS-only session that does not record, transcribe, or create meeting artifacts.

### Goals

- Speak every message in the voice-channel text chat while a meeting is active.
- Allow /say to speak a single message without enabling auto TTS.
- Speak only for users currently in the voice channel.
- Allow server default + channel override (channel can enable even if server default is off).
- Allow per-user opt-out ("do not speak my messages").
- Allow per-user voice selection (per server).
- Allow per-user volume selection (per server).
- Ensure bot audio never overlaps and supports a stop/clear command.
- Include spoken chat in recording and transcript.
- Allow explicit /say playback in TTS-only mode without recording or transcription.
- Avoid duplicate chat vs transcript entries in the Library timeline.

### Non-goals (Future improvements)

- Role-based permissions for chat-to-speech and /say.
- Dedicated TTS-only text channel.
- Global user preferences across servers.
- Advanced rate limiting beyond simple caps.
- User-specific "do not hear others" (not feasible in shared voice).
- Multi-voice or multi-language routing.

---

## Feature behavior

### When TTS triggers

- A meeting is active in a guild and chat-to-speech is enabled (resolved from defaults/overrides).
- Message is in the voice channel's associated text chat (the channel where the meeting was started or configured for auto-record).
- Message author is currently connected to the same voice channel.
- Message author is not a bot.
- Message content is non-empty after trimming.
- If no recorded meeting is active, automatic chat-to-speech can start a TTS-only session when `chatTts.enabled` and `chatTts.ttsOnly.enabled` both resolve true for the voice channel.

### Playback behavior

- All bot audio (Chronote live voice replies and chat-to-speech) goes through a single per-meeting queue.
- Audio is serialized; one utterance must finish before the next plays.
- A /tts stop command stops the current playback and clears the queue.

### Recording and transcript

- TTS audio is mixed into the meeting recording (same pipeline as live voice).
- Each spoken chat message adds a transcript segment with:
  - source: "chat_tts"
  - messageId (Discord message id)
- The transcript remains the canonical "what was heard" source.
- TTS-only sessions are different: they do not create a recording, transcript, notes, or meeting history artifact.

### TTS-only auto-start

- Auto-record has priority over auto TTS. If auto-record starts, chat TTS stays inside that recorded meeting.
- If auto-record does not start and automatic chat TTS is enabled for the joined voice channel, Chronote can join in TTS-only mode.
- TTS-only auto-start uses the configured notes/status channel for public status messages, but it listens only for voice-channel text chat to speak messages.
- TTS-only auto-start does not subscribe to member voice, open a recording output, or create meeting history.

### Library timeline (de-dupe)

- Chat entries are still stored in chat.json for export and audit.
- Timeline merges transcript segments and chat log:
  - If a transcript segment has source: "chat_tts", render it as a dedicated event type (e.g., tts) and suppress the matching chat entry by messageId to avoid duplicates.

---

## Settings and precedence

### Server defaults

Stored in ServerContext:

- chatTtsEnabled?: boolean
- chatTtsVoice?: string (server default voice for user TTS)
- liveVoiceTtsVoice?: string (server default voice for Chronote live voice, distinct from user TTS)

### Channel override

Stored in ChannelContext:

- chatTtsEnabled?: boolean (nullable/tri-state, like liveVoiceEnabled)

### Per-user (per-server) settings

New UserSpeechSettings table:

- guildId (pk)
- userId (sk)
- chatTtsDisabled?: boolean
- chatTtsVoice?: string
- chatTtsSpokenName?: string
- chatTtsSpeakerPrefixMode?: "never" | "chat_only" | "always"
- chatTtsVolumePercent?: number
- updatedAt, updatedBy

### Resolution order (MVP)

- finalChatTtsEnabled = limits.liveVoiceEnabled && (channelOverride ?? serverDefault)
- Per-user does not enable; it only disables:
  - If chatTtsDisabled === true, do not speak that user's messages.
- Voice selection:
  - voice = user.chatTtsVoice ?? server.chatTtsVoice ?? config default
- Volume selection:
  - volume = user.chatTtsVolumePercent ?? 100
- Chronote live voice uses:
  - server.liveVoiceTtsVoice ?? config default

---

## Data model changes

### ChatEntry

Add:

- messageId?: string
- source?: "chat" | "chat_tts" (default "chat")

### Transcript segment

Extend JSON in S3 with optional fields:

- source?: "voice" | "chat_tts" | "bot"
- messageId?: string

### DynamoDB

Add table: UserSpeechSettings

- Partition key: guildId
- Sort key: userId
- PAY_PER_REQUEST, PITR, KMS app_general (match existing)

---

## Commands and UI

### Discord commands

1. /tts disable - opt out (per server)
2. /tts enable - remove opt-out
3. /tts voice <voice> - set per-user voice (per server)
4. /tts prefix `mode` - set whether speech includes the user's name
5. /tts nickname `name` - set the spoken TTS name
6. /tts volume `percent` - set per-user TTS volume; 100 resets to default
7. /tts stop - stop current playback and clear queue (requires ManageChannels OR meeting creator)
8. /leave - disconnect Chronote from TTS-only mode; `confirm:true` ends an active recorded meeting after permission checks
9. /say message - speak one message aloud (requires voice channel presence; can start TTS-only mode)

### Frontend Settings (server settings page)

Global defaults:

- Toggle: "Enable chat-to-speech by default"
- Select: "Default chat-to-speech voice"
- Select: "Default Chronote voice"
  Channel override list:
- Toggle per channel: "Chat-to-speech override"

### Library timeline

Add event type tts with a unique icon and label (e.g., "Spoken chat").

---

## Abuse controls (MVP)

- Max characters per spoken message (config default, e.g., 400).
- Max queue depth per meeting (config default, e.g., 10).
- If a message exceeds limit: truncate or skip with a brief warning in text channel.
- /tts stop to kill current playback and clear queue.

---

## Telemetry and logging

- Log when TTS is enqueued, truncated, skipped (opt-out, not in voice, disabled, queue full).
- Add counters: chat_tts_enqueued, chat_tts_spoken, chat_tts_dropped.

---

## Testing plan

1. Unit tests:
   - Resolver precedence (server/channel/user).
   - Queue behavior (serial playback, stop/clear).
   - Chat entry -> transcript segment mapping with messageId.
2. Integration tests:
   - Meeting start respects limits.liveVoiceEnabled gating for chat TTS.
   - Library timeline dedupe for chat_tts.
3. Manual:
   - Start meeting, send messages as voice channel member and non-member.
   - Confirm bot speaks only member messages.
   - Toggle server default and channel override; verify behavior.
   - Set per-user voice, volume, and opt-out.
   - Test /tts stop.
