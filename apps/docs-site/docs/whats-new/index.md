---
title: What's New
slug: /whats-new
---

Notable product changes for Chronote users. For the full changelog, see the [GitHub releases](https://github.com/Chronote-gg/Chronote/releases).

## 2026

### Personal media uploads

- Upload existing audio or video files from the web portal to create personal Chronote meetings.
- Uploaded media is transcribed, summarized, and saved in My Meetings under your personal workspace.
- Optional titles and tags can be added before processing starts.
- Personal Notion automation can export uploaded and personal meetings to your Notion destination after processing completes.

### Remote MCP live controls

- AI assistants can now start Chronote recordings from your current Discord voice channel through Remote MCP.
- Remote MCP can stop active meetings, check live meeting status, and fetch available live transcript events using existing meeting/transcript scopes plus separate start/stop OAuth consent scopes.
- Meeting control requests are queued so Chronote can route work to the bot runtime that owns the live recording.

### Transcription reliability guardrails

- Low-confidence transcription retries now reject punctuation-only outputs before they can replace a real transcript.
- Finalized meeting audio gets an extra verification pass to clean up repeated short hallucinations before notes are generated.

### Public documentation launch

- Product documentation is now available at [docs.chronote.gg](https://docs.chronote.gg).
- Docs cover getting started, features, admin setup, and troubleshooting.
- Documentation updates ship alongside product changes.

### Meeting sharing

- Share meeting notes via a public link from the web portal.
- Recipients can view the meeting summary, notes, and transcript without joining your server.

### Notes correction flow

- Suggest corrections to meeting notes directly from Discord or the web portal.
- Corrections use the original transcript as ground truth, so the AI cannot add content that was not discussed.
- Versioned notes track every edit with author attribution.

### Text-to-speech

- Use `/tts enable` to have your chat messages spoken aloud in the meeting voice channel.
- Choose from multiple voice options with `/tts voice`.
- Set your spoken name, speaker prefix mode, and volume from `/tts`.
- Use `/say` for one-off messages without enabling ongoing TTS.
- Enable TTS-only channel startup so Chronote can speak chat messages without recording, transcription, notes, chat logs, or meeting artifacts.
- TTS-only sessions now clean themselves up after inactivity, and servers may see a monthly chat-to-speech cap notice when plan limits are reached.
- Use `/leave` to make Chronote leave a TTS-only session immediately, or require explicit confirmation before ending a recorded meeting.

### Ask past meetings

- Use `/ask` to query your meeting history with natural-language questions.
- Answers include citations linking to specific meetings.
- Filter by tags or scope to a single channel.
