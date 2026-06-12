# TTS/STT Privacy and Provider Plan

## Summary

Chronote currently treats text-to-speech as part of an active recorded meeting. That is fine for meeting recordings, but it cannot satisfy a strict TTS-only privacy mode because `initializeMeeting` always creates a recording output, subscribes to member voice, and installs speaking handlers.

The next design should split "the bot is connected and can speak" from "Chronote is capturing user audio." TTS-only must be a first-class runtime mode with no voice receiver subscriptions, no output recording, no speech-to-text, no live voice commands, and no transcript or notes generation.

## Current Behavior

- `docs/tts-mvp-spec.md` says chat TTS is included in the meeting recording and transcript.
- `src/meetings.ts` always calls `openOutputFile(meeting)` after joining the voice channel.
- `src/meetings.ts` always subscribes to all current members with `subscribeToUserVoice`.
- `src/meetings.ts` always installs receiver speaking `start` and `end` handlers.
- `src/meetings.ts` always creates a text chat collector, stores chat entries, and calls `maybeSpeakChatMessage`.
- `src/ttsQueue.ts` tees TTS PCM into `meeting.audioData.audioPassThrough` when that recording stream exists.
- `src/commands/say.ts` requires an active meeting and stores `/say` as a `chat_tts` chat entry.
- `src/services/meetingVoiceSettingsService.ts` gates live voice, live commands, and chat TTS on the existing `limits.liveVoiceEnabled` tier flag.
- `src/config/registry.ts` already supports global AppConfig defaults and server/channel overrides for TTS-style booleans.
- `src/utils/participants.ts` already has display-name helpers that prefer server nickname, then global display name, then username/tag.
- `docs/dictionary.md` and `src/services/transcriptionPromptService.ts` already support server dictionary terms in transcription prompts.

## Product Modes

Use explicit modes instead of overloading `transcribeMeeting`.

- Recording meeting: captures member voice, writes an audio recording, optionally transcribes, generates notes, and may mix bot TTS into the saved recording.
- Listen/STT mode: captures member voice for live transcription or live commands, but does not necessarily persist a normal meeting recording. This should remain out of scope unless we intentionally add it.
- TTS-only mode: bot joins to speak, but captures no user audio and creates no meeting artifact.

Recommended MVP: implement recording meeting and TTS-only mode. Do not add listen/STT-only until there is a concrete product request.

## Privacy Requirements

TTS-only mode must guarantee these behaviors:

- Do not call `openOutputFile`.
- Do not call `subscribeToUserVoice`.
- Do not attach `receiver.speaking` handlers that feed the audio pipeline.
- Do not run transcription, final-pass verification, cleanup, or notes generation.
- Do not store chat as meeting history or transcript data unless we intentionally add a separate moderation/audit feature later.
- Do not pass ambient chat history to an LLM for TTS. Only the specific text selected for speech may be sent to the TTS provider.
- Do not enable live voice responses or live voice commands in the same session.
- If the bot can update its nickname/status, show that it is in a non-recording TTS mode.
- End idle TTS-only sessions automatically so the bot does not remain connected without speech activity.

## Recommended Data Model

Add a small runtime/session distinction rather than stretching `MeetingData` forever.

- Add `VoiceSessionMode = "meeting" | "tts_only"`.
- Add `captureAudio: boolean` or equivalent to the session object.
- Add `recordBotAudio: boolean` so meeting mode can keep current behavior while TTS-only disables the PCM tee.
- Add `storeChatLog: boolean` so meeting mode can keep the timeline, while TTS-only can avoid persistence.
- Add `enableTranscription: boolean` separate from `captureAudio` if later listen-only behavior needs it.

Minimal path: keep `MeetingData` for now, add these explicit flags, and guard existing recording/capture paths. Cleaner path: create a `VoiceSessionData` base type with meeting-only fields split out later.

Recommended MVP is the minimal path if we are implementing soon. It reduces blast radius and avoids a large meeting lifecycle refactor.

## Config Plan

Use the existing config registry and precedence model.

Add or refine these keys:

- `chatTts.enabled`: existing, keep server/channel override.
- `chatTts.voice`: existing, keep global/server override.
- `chatTts.mode`: new select, recommended values `meeting_only` and `tts_only_allowed`.
- `chatTts.announceSpeaker.enabled`: new boolean, default `true` for normal chat TTS, configurable globally/server-side.
- `chatTts.announceSpeaker.template`: optional string, default `{name} said: {message}` if templating is worth the extra UI surface.
- `chatTts.statusNickname.enabled`: new boolean, default `true` if the bot has permission.
- `chatTts.statusNickname.ttsOnly`: optional suffix, for example `(TTS Only)`.
- `chatTts.statusNickname.recording`: optional suffix, for example `(Recording)`.
- `CHAT_TTS_TTS_ONLY_IDLE_TIMEOUT_MS`: environment-level idle timeout for TTS-only sessions.
- `CHAT_TTS_MONTHLY_*_MESSAGE_LIMIT`: environment-level monthly accepted-message caps by tier.
- `liveVoice.commands.enabled`: existing, but force off in TTS-only runtime.
- `liveVoice.enabled`: existing, but force off in TTS-only runtime.

Avoid a key named `/speech-to-text` or a setting label that suggests recording. Use user-facing labels like "Transcription" or "Voice capture" for features that actually listen.

## Command and UX Plan

Recommended commands and behavior:

- `/say message`: keep as an explicit one-shot TTS command. It should work in TTS-only mode and recorded meetings.
- `/tts start`: starts a TTS-only session in the user's current voice channel when no meeting/session is active.
- `/tts stop`: stops current TTS playback and ends a TTS-only session, or just clears playback during a recorded meeting.
- `/tts voice`: keep per-user voice selection.
- `/tts enable` and `/tts disable`: keep per-user opt out from automatic chat TTS.
- `/tts nickname`: optional future command for per-user spoken display name.
- `/whois`: optional future command to show stored TTS nickname, Discord display name, and server nickname mapping.

TTS-only session copy should explicitly say "No recording or transcription is active." It should not say "meeting started."

## TTS Text Formatting

For automatic chat TTS, the spoken text should usually include the effective speaker name:

- Default spoken form: `{displayName} said: {message}`.
- `displayName` should use `formatParticipantLabel` or equivalent effective display-name logic.
- `/say` can either speak only the user-provided message or use the same prefix, controlled by config.
- Per-user TTS nicknames can override Discord display names later, but should not be required for MVP.

Keep this deterministic. Do not add fuzzy name inference. Store explicit nicknames if users want different pronunciation or presentation.

## STT and Dictionary Plan

Current OpenAI STT support is already prompt-based:

- The transcription prompt includes server name, channel, attendees, bot names, dictionary terms, and meeting context.
- Dictionary terms are terms only for transcription and terms plus definitions for cleanup/notes/Ask.

Recommended improvements:

- Add pronunciation/name metadata to dictionary entries only if needed by a provider or a concrete UX decision.
- Keep OpenAI prompt injection for the current provider.
- For providers with first-class custom vocabulary, map existing dictionary terms into provider-native hints.
- Keep definitions out of provider-native STT hints unless the provider explicitly supports semantic hints.
- Add tests around dictionary budget behavior before adding provider-specific expansion.

Potential dictionary fields for future provider support:

- `pronunciation?: string` for human-readable pronunciation guidance.
- `aliases?: string[]` for explicit alternate spellings.
- `providerHints?: Record<string, unknown>` only if needed after provider selection.

Do not add arbitrary natural-language alias heuristics. If users need a name pronounced a certain way, collect explicit aliases or pronunciations.

## Provider Research Snapshot

OpenAI:

- TTS is already wired through `audio.speech.create`.
- Newer voices such as `marin` and `cedar` should be considered for quality.
- TTS supports `instructions`, which can help with tone and style.
- STT supports prompt text, which Chronote already uses through Langfuse prompt composition.
- Provider-native pronunciation dictionaries are limited compared with specialized vendors.

ElevenLabs:

- Strong TTS voice quality.
- Supports pronunciation dictionaries using alias or phoneme rules.
- Good candidate for premium TTS quality and proper-name pronunciation.

Cartesia:

- Strong low-latency TTS positioning.
- Supports pronunciation dictionary IDs.
- Good candidate if voice responsiveness becomes the key differentiator.

Deepgram:

- Strong STT option.
- Nova/Flux support keyterm-style customization.
- Good candidate for live/streaming STT improvements.

AssemblyAI:

- Strong STT customization surface.
- Universal-style async transcription supports large keyterm prompts.
- Streaming supports keyterms and can update terms during a session.
- Also supports custom spelling mappings.

AWS:

- Amazon Transcribe supports custom vocabulary.
- Amazon Polly supports pronunciation lexicons.
- Good enterprise and AWS-native option, but integration is broader than a small OpenAI swap.

Google and Azure:

- Google STT supports adaptation and phrase hints.
- Azure Speech supports Custom Speech.
- Good enterprise options, especially for customers already committed to those clouds.

Recommended provider path:

- Keep OpenAI as the default for now.
- Add provider abstraction only at the service boundary, not throughout meeting logic.
- Trial one TTS competitor first if the goal is voice quality.
- Trial one STT competitor first if the goal is proper-name accuracy and streaming voice commands.
- Do not add multi-provider UI until at least two providers are actually integrated and tested.

## Implementation Sequence

1. Add explicit session/capture flags to `MeetingInitOptions` and `MeetingData`.
2. Guard `openOutputFile`, voice subscriptions, and speaking handlers behind `captureAudio`.
3. Guard TTS PCM tee behind `recordBotAudio`.
4. Make end-meeting logic tolerate no recording output for TTS-only sessions.
5. Add a TTS-only session starter and lifecycle path.
6. Allow `/say` to create or use a TTS-only session when there is no recorded meeting.
7. Add spoken speaker-name prefixing with effective display names.
8. Add config registry entries for TTS-only allowance and announcement formatting.
9. Add bot nickname/status best-effort updates, gated by Discord permissions.
10. Add voice-join auto-start for channel-based chat TTS when `chatTts.enabled` and `chatTts.ttsOnly.enabled` resolve true.
11. Update docs to distinguish recording meetings from TTS-only sessions.
12. Add tests for no-capture invariants and config resolution.

## Current Automation Shape

Automatic TTS-only sessions should use the existing config system instead of creating another persistence model:

- `chatTts.enabled` resolves global/server/channel automatic chat TTS behavior.
- `chatTts.ttsOnly.enabled` resolves whether automatic chat TTS may start outside a recording.
- `notes.channelId` resolves the status/notification text channel for an auto-started TTS-only session.
- Auto-record remains higher priority. If auto-record starts for a voice join, a separate TTS-only session should not start.
- When a recorded meeting is active, automatic chat TTS stays inside the recorded meeting and keeps the current recording/transcript behavior.
- TTS-only sessions reset an inactivity timer when chat-to-speech activity is accepted or spoken, then disconnect with a clear no-recording notice after the idle timeout.
- Chat-to-speech accepted messages are counted in a monthly DynamoDB usage record so capped tiers get a hard stop and upgrade/support CTA when the cap is reached.

Open UX follow-up: the backend shape now behaves like channel automation, but the Discord command and website UX should still decide whether this appears under `/tts`, `/autorecord`, or a combined "voice automation" surface.

## Test Plan

Unit tests:

- TTS-only initialization does not call recording or voice subscription helpers.
- TTS-only idle timeout arms, resets on activity, and ends the session.
- Chat TTS monthly usage caps allow below-limit messages, block at the limit, and release a reserved count if the queue rejects the message.
- Meeting initialization still records and subscribes normally.
- TTS queue does not write PCM to a recording stream when `recordBotAudio` is false.
- Chat TTS prefixes messages with the effective display name when configured.
- TTS-only mode forces live voice and live commands off.

Integration or mock-mode tests:

- `/tts start` joins voice without creating meeting history.
- `/say` works without an active recorded meeting when TTS-only is allowed.
- `/say` still works inside a recorded meeting.
- Ending a TTS-only session does not attempt to upload audio/transcript/notes.

Manual checks:

- Bot status/nickname clearly shows non-recording mode when possible.
- Discord voice UI shows the bot joined and playing audio.
- No local temp recording file is created for TTS-only.
- No transcript, notes, or meeting history record appears for TTS-only.

## Open Product Decisions

Decisions accepted for the first implementation pass:

1. Should `/say` outside a meeting auto-start a TTS-only session?
   Decision: yes, when TTS-only is enabled and the user is in voice.

2. Should automatic chat TTS work in TTS-only mode, or only `/say`?
   Decision: automatic chat TTS should be channel-based like auto-record. Use `chatTts.enabled` plus `chatTts.ttsOnly.enabled` to auto-start a TTS-only session when someone joins an enabled voice channel. Product work should still consider whether auto-record and auto-TTS are conceptually one "voice channel automation" surface in Discord commands and website settings.

3. Should spoken `/say` include "Name said" by default?
   Decision: configurable at global, server, and player levels. Player-level config must be added or reused if available.

4. Should TTS-only produce any persisted audit event?
   Decision: no meeting artifact. Keep operational logs and metrics only.

5. Which provider trial comes first?
   Decision: keep OpenAI for the privacy-mode implementation. File provider trials as fast follow, with ElevenLabs or Cartesia as the first TTS-quality candidates.

6. Should per-user spoken nicknames and `/whois` be part of the MVP?
   Decision: yes, plan and implement them in the same pass.

7. Should recorded meetings keep current behavior where TTS is included in recordings/transcripts?
   Decision: yes. Only TTS-only mode is no-capture/no-artifacts.
