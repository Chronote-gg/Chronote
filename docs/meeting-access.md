# Meeting access and permissions

Chronote tries to make meeting privacy match Discord as closely as possible.

## Discord messages (summary + notes)

- Meeting summaries and notes are posted as normal Discord messages in a text channel.
- Discord channel permissions control who can read them.

## Web portal (My Meetings + Library + Ask)

The portal can show additional artifacts (transcript text, timeline, audio playback). Access is based on Discord permissions.

By default, a user can view a meeting through server-scoped Library or Ask if they:

1. Are still a member of the server.
2. Can join the meeting's voice channel.
   - Required Discord permissions: `View Channel` and `Connect` on that voice channel.
3. Can read the meeting's notes channel history.
   - Required Discord permissions: `View Channel` and `Read Message History` on the text channel where Chronote posted the meeting summary/notes.

### Attendee exception

If a user participated in the meeting (their Discord user id appears in the meeting's stored participant snapshot), Chronote can allow portal access even if they no longer have access to the voice or notes channel.

This exception is meant to support common workflows like role changes after a meeting. User-centric surfaces such as My Meetings and MCP can list and open indexed attended meetings without requiring current server membership. Server Library remains a server-scoped browsing view.

This behavior is controlled by the server setting `meetings.attendeeAccess.enabled` (default: enabled).

## Server-wide artifact access

After a user passes the meeting access check, Chronote applies two independent server settings at read time:

- `meetings.artifacts.transcriptAccess.enabled` controls transcript text, transcript-derived timelines, shared transcript surfaces, completed MCP transcript retrieval, and new live transcript connections.
- `meetings.artifacts.audioAccess.enabled` controls signed audio playback URLs and portal export fields.

Both default to enabled and apply retroactively to existing and future server meetings. They are access controls only: recording, transcription, notes generation, storage, and transcript-backed notes correction continue. Personal meetings bypass these server settings because their owner controls access.

Chronote does not terminate an already-open live transcript stream when an admin changes the setting. It stays connected until the meeting ends or the viewer disconnects. New live connections and subsequent artifact requests use the current setting. An issued audio URL remains usable for up to 15 minutes.

### Ask uses the same rules

When you use Ask (both in the portal and via `/ask` in Discord), Chronote only searches meetings you can access under the same rules as the active surface.

## Notes

- Access is evaluated at view-time, based on current Discord permissions (plus the attendee exception).
- Older meeting records may not include the notes channel id. For those records, Chronote can only enforce voice-channel access.
- Audio playback links are short-lived signed URLs.
- A disabled artifact is omitted at the server boundary, not merely hidden in the frontend.
- Re-enabling an artifact setting makes stored artifacts available again. Deletion is a separate operation.
