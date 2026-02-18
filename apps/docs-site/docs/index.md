---
title: Chronote Docs
slug: /
---

Chronote is a Discord bot that records voice meetings, transcribes the conversation with AI, and posts structured meeting notes back to your channel. Every meeting is searchable, shareable, and correctable.

## Quick links

| I want to...                         | Go to                                                  |
| ------------------------------------ | ------------------------------------------------------ |
| Add Chronote to my server            | [Getting Started](/getting-started/)                   |
| Understand how a meeting flows       | [Meeting Lifecycle](/core-concepts/meeting-lifecycle/) |
| See what commands and features exist | [Features](/features/)                                 |
| Set up auto-recording or context     | [Admin Guide](/admin/setup-and-access/)                |
| Fix something that is not working    | [Troubleshooting](/troubleshooting/common-issues/)     |
| Read about recent changes            | [What's New](/whats-new/)                              |

## How it works

1. **Record**: Start a meeting with `/startmeeting` or let auto-record handle it when someone joins a voice channel.
2. **Transcribe**: Chronote captures each speaker's audio, transcribes it in real time, and applies noise filtering and quality checks.
3. **Generate notes**: An AI model reads the full transcript along with your server context and dictionary terms, then produces structured meeting notes.
4. **Share**: Notes are posted as Discord embeds. They are also saved to your meeting history and accessible through the Chronote web portal.

## Key capabilities

- **Per-speaker transcription** with configurable context and dictionary terms for domain accuracy.
- **Auto-recording** at the server or channel level, so meetings are captured without manual commands.
- **Notes correction** workflow where any attendee can suggest edits, reviewed and approved before applying.
- **Meeting history** with full transcripts, audio, chat logs, and versioned notes.
- **Ask** past meetings natural-language questions with `/ask` and get sourced answers.
- **Text-to-speech** so remote participants can have their chat messages spoken aloud in voice.
- **Image generation** to create a visual summary of your meeting using DALL-E.
- **Web portal** for browsing meetings, sharing links, and managing settings outside Discord.

## Looking for release updates?

See [What's New](/whats-new/) for recent product changes.
