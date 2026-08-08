---
title: What's New
slug: /whats-new
---

Notable product changes for Chronote users. For the full changelog, see the [GitHub releases](https://github.com/Chronote-gg/Chronote/releases).

## 2026

### Analytics now cover what you do in Discord

- Product analytics now record actions taken through Chronote in Discord, not only on the website and web portal. They capture that an action happened and its shape, never its content.
- While you are signed in, analytics are tied to your Discord account rather than an anonymous browser identifier. Signing out unlinks the browser again.
- IP addresses are discarded on arrival, so we no longer derive an approximate location from them.
- Do Not Track still covers the website and portal, but cannot cover Discord, because the bot never sees your browser. Email us to opt out of that side.
- See [Analytics now cover what you do in Discord](/whats-new/analytics-in-discord) and the updated [privacy policy](/legal/privacy).

### Role mentions in meeting notes

- Notes now mention server roles when work is assigned to a group rather than to one person.
- Member and role mentions can appear anywhere in the notes.
- Role mentions resolve to readable role names in the web portal, shared links, Notion exports, and Markdown exports.
- Mentions in notes stay display-only, so posting notes still does not ping anyone.

### Personal media uploads

- Upload existing audio or video files from the web portal to create personal Chronote meetings.
- Uploaded media is transcribed, summarized, and saved in My Meetings under your personal workspace.
- Optional titles and tags can be added before processing starts.
- Personal Notion automation can export uploaded and personal meetings to your Notion destination after processing completes.
- Personal Notion automation is managed from Personal Settings, keeping My Meetings focused on finding and opening meetings.
- The web portal sidebar now separates Personal flows from Server flows so account-owned meetings, uploads, and integrations are visually distinct from server Library, Ask, Billing, and Server Settings.

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
