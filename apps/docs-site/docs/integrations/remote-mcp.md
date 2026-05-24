---
title: Remote MCP
slug: /integrations/remote-mcp
---

Chronote exposes a remote MCP (Model Context Protocol) endpoint for AI assistants and agents that need meeting context.

The endpoint is read-only today and uses OAuth with Discord sign-in. Chronote checks the same meeting access rules used by the web portal before returning data.

## Endpoint

Use the API MCP endpoint:

```text
https://api.chronote.gg/mcp
```

Self-hosted deployments should use their own API base URL plus `/mcp`.

Remote MCP requires Discord OAuth and `OAUTH_SECRET` to be configured. Set `MCP_PUBLIC_BASE_URL` to the externally reachable API origin if it differs from the server's internal URL.

## Available Tools

- `list_servers`: Lists Discord servers where the authenticated user can access Chronote data.
- `list_meetings`: Lists recent meetings in a server, with optional channel, date, tag, and archived filters.
- `list_my_meetings`: Lists meetings across servers for the authenticated user. It defaults to meetings the user attended in the past 7 days and can also list meetings the user can access. Use `today` or `past_7_days` without `startDate` or `endDate`. Use `range: "custom"` when you need explicit date bounds.
- `get_meeting_summary`: Returns notes and metadata for one accessible meeting.
- `get_meeting_transcript`: Returns transcript text for one accessible meeting. Use `offset` and `maxChars` to page through long transcripts.

For follow-up fetch tools, use the list item's `id` field. Do not pass the UUID-style `meetingId` field.

Example flow:

1. Call `list_meetings` or `list_my_meetings`.
2. Take the returned `id` value, for example `123456789012345678#2026-05-08T01:06:47.307Z`.
3. Pass that `id` into `get_meeting_summary` or `get_meeting_transcript`.

For long transcripts, request a window at a time:

1. Call `get_meeting_transcript` with `id`, optionally adding `maxChars`.
2. If the response includes `truncated: true`, call it again with `offset` set to `nextOffset`.

## Date Range Tips

- For preset My Meetings ranges, send `range: "today"` or `range: "past_7_days"` and omit `startDate` and `endDate`.
- For explicit windows, send `range: "custom"` with `startDate`, and optionally `endDate`.
- Chronote rejects mixed inputs such as `range: "past_7_days"` with a manual `startDate`.

## OAuth Scopes

- `meetings:read`: Required for server lists, meeting lists, and meeting summaries.
- `transcripts:read`: Required in addition to `meetings:read` for transcript text.

## OpenCode Example

```json
{
  "mcp": {
    "chronote": {
      "type": "remote",
      "url": "https://api.chronote.gg/mcp",
      "oauth": {}
    }
  }
}
```

When your MCP client connects, it opens a Chronote authorization flow in the browser. Sign in with Discord, review the requested scopes, and approve the client.

## Access Rules

Chronote only returns meeting data if the authenticated Discord user can access the meeting. Access follows the same model as My Meetings and Server Library:

- Users who participated can access their indexed meetings when attendee access is enabled.
- Other users need access to the voice channel and notes channel history.
- Transcript access requires explicit transcript scope consent.

Future write tools will use narrower scopes and separate consent.
