---
title: Remote MCP
slug: /integrations/remote-mcp
---

Chronote exposes a remote MCP (Model Context Protocol) endpoint for AI assistants and agents that need meeting context or want to control live recordings.

The endpoint uses OAuth with Discord sign-in. Chronote checks the same meeting access rules used by the web portal before returning data, and write tools require separate consent scopes.

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
- `list_my_meetings`: Lists meetings across servers for the authenticated user. It defaults to meetings the user attended in the past 7 days and can also list meetings the user can access. Use `all`, `today`, or `past_7_days` without `startDate` or `endDate`. Use `range: "custom"` when you need explicit date bounds. If the response includes `nextCursor`, pass it as `cursor` to fetch the next page.
- `get_meeting_summary`: Returns notes and metadata for one accessible meeting.
- `get_meeting_transcript`: Returns transcript text for one accessible meeting. Use `offset` and `maxChars` to page through long transcripts.
- `start_meeting`: Starts a Chronote recording from the authenticated user's current Discord voice channel. Optionally pass `serverId`, `voiceChannelId`, `textChannelId`, `context`, and `tags`.
- `stop_meeting`: Stops the active Chronote meeting, either by `serverId` or by inferring the server from the authenticated user's current voice channel. Pass `meetingId` to guard against stopping the wrong meeting.
- `get_live_meeting_status`: Returns status for an active meeting.
- `get_live_meeting_transcript`: Returns currently available live transcript events. Pass `serverId` so the request reaches the bot runtime that owns the meeting, and use `afterEventId` to page from the last event you saw.
- `get_meeting_control_request`: Checks a queued start, stop, or live meeting request by `requestId`.

For follow-up fetch tools, use the list item's `id` field. Do not pass the UUID-style `meetingId` field.

Example flow:

1. Call `list_meetings` or `list_my_meetings`.
2. Take the returned `id` value, for example `<server-id>#2026-05-08T01:06:47.307Z`.
3. Pass that `id` into `get_meeting_summary` or `get_meeting_transcript`.

For long transcripts, request a window at a time:

1. Call `get_meeting_transcript` with `id`, optionally adding `maxChars`.
2. If the response includes `truncated: true`, call it again with `offset` set to `nextOffset`.

## Live Control Tips

- Join the Discord voice channel before calling `start_meeting` without explicit IDs.
- If you are connected in multiple servers, pass `serverId`.
- If the server does not have a default notes channel, pass `textChannelId`.
- Write and live tools may return `requestStatus: "pending"` with a `requestId` while a bot worker completes the command. Call `get_meeting_control_request` with that `requestId` to check the result.
- `stop_meeting` can be used by the meeting creator or members with meeting-management permissions.

## Date Range Tips

- For preset My Meetings ranges, send `range: "all"`, `range: "today"`, or `range: "past_7_days"` and omit `startDate` and `endDate`.
- For explicit windows, send `range: "custom"` with `startDate`, and optionally `endDate`.
- Chronote rejects mixed inputs such as `range: "past_7_days"` with a manual `startDate`.

## OAuth Scopes

- `meetings:read`: Required for server lists, meeting lists, and meeting summaries.
- `transcripts:read`: Required in addition to `meetings:read` for transcript text.
- `meetings:start`: Required to start recordings through MCP.
- `meetings:stop`: Required to stop recordings through MCP.
- `get_meeting_control_request` requires a valid MCP token and only returns requests created by the authenticated user.

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
- Starting a live meeting requires the authenticated Discord user to already be in the target voice channel.
- Stopping a meeting requires creator or meeting-management permissions.
