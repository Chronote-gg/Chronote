# Meeting access and permissions

Chronote tries to make meeting privacy match Discord as closely as possible.

## Discord messages (summary + notes)

- Meeting summaries and notes are posted as normal Discord messages in a text channel.
- Discord channel permissions control who can read them.

## Web portal (Library + Ask)

The portal can show additional artifacts (transcript text, timeline, audio playback). Access is based on Discord permissions.

By default, a user can view a meeting in the portal if they:

1. Are still a member of the server.
2. Can join the meeting's voice channel.
   - Required Discord permissions: `View Channel` and `Connect` on that voice channel.
3. Can read the meeting's notes channel history.
   - Required Discord permissions: `View Channel` and `Read Message History` on the text channel where Chronote posted the meeting summary/notes.

### Attendee exception

If a user participated in the meeting (their Discord user id appears in the meeting's stored participant snapshot), Chronote can allow portal access even if they no longer have access to the voice or notes channel.

This exception is meant to support common workflows like role changes after a meeting. Users still need to be a member of the server.

This behavior is controlled by the server setting `meetings.attendeeAccess.enabled` (default: enabled).

### Ask uses the same rules

When you use Ask (both in the portal and via `/ask` in Discord), Chronote only searches meetings you can access under the same rules as the Library.

## Notes

- Access is evaluated at view-time, based on current Discord permissions (plus the attendee exception).
- Older meeting records may not include the notes channel id. For those records, Chronote can only enforce voice-channel access.
- Audio playback links are short-lived signed URLs.
