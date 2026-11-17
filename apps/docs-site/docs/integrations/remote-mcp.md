---
title: Remote MCP
slug: /integrations/remote-mcp
---

Chronote exposes a remote MCP (Model Context Protocol) endpoint for AI assistants and agents that need meeting context or want to control live recordings.

The endpoint uses OAuth with Discord sign-in. Chronote checks the same meeting access rules used by the web portal before returning data, and write tools require separate consent scopes.

For an unattended agent that cannot complete a browser sign-in, see [Service Accounts](/integrations/service-accounts).

## Endpoint

Use the API MCP endpoint:

```text
https://api.chronote.gg/mcp
```

Self-hosted deployments should use their own API base URL plus `/mcp`.

Remote MCP requires Discord OAuth and `OAUTH_SECRET` to be configured. Set `MCP_PUBLIC_BASE_URL` to the externally reachable API origin if it differs from the server's internal URL.

## Available Tools

- `list_servers`: Lists Discord servers where the authenticated user can access Chronote data.
- `search_meetings`: Searches accessible retained meeting titles, summaries and complete current notes. Results include the complete meeting notes and search-coverage status.
- `search_transcripts`: Searches passages only within a required, nonempty set of selected meetings. Requires both `meetings:read` and `transcripts:read`.
- `list_meetings`: Lists meetings in a server, with optional channel, date, tag, and archived filters.
- `list_my_meetings`: Lists meetings across servers for the authenticated user. It defaults to meetings the user attended in the past 7 days and can also list meetings the user can access. Use `all`, `today`, or `past_7_days` without `startDate` or `endDate`. Use `range: "custom"` when you need explicit date bounds. If the response includes `nextCursor`, pass it as `cursor` to fetch the next page.
- `get_meeting_summary`: Returns notes and metadata for one accessible meeting.
- `get_meeting_transcript`: Returns transcript text for one accessible meeting when that server allows transcript access. Use `offset` and `maxChars` to page through long transcripts.
- `start_meeting`: Starts a Chronote recording from the authenticated user's current Discord voice channel. Optionally pass `serverId`, `voiceChannelId`, `textChannelId`, `context`, and `tags`.
- `stop_meeting`: Stops the active Chronote meeting, either by `serverId` or by inferring the server from the authenticated user's current voice channel. Pass `meetingId` to guard against stopping the wrong meeting.
- `get_live_meeting_status`: Returns status for an active meeting.
- `get_live_meeting_transcript`: Returns currently available live transcript events when that server allows transcript access. Pass `serverId` so the request reaches the bot runtime that owns the meeting, and use `afterEventId` to page from the last event you saw.
- `get_meeting_control_request`: Checks a queued start, stop, or live meeting request by `requestId`.

For follow-up fetch tools, use the list item's `id` field. Do not pass the UUID-style `meetingId` field.

Example flow:

1. Call `list_meetings` or `list_my_meetings`.
2. Take the returned `id` value, for example `<server-id>#2026-05-08T01:06:47.307Z`.
3. Pass that `id` into `get_meeting_summary` or `get_meeting_transcript`.

For long transcripts, request a window at a time:

1. Call `get_meeting_transcript` with `id`, optionally adding `maxChars`.
2. If the response includes `truncated: true`, call it again with `offset` set to `nextOffset`.

## Search meeting history

When search is enabled, every plan can search the same accessible retained history. There is no last-5, last-25 or last-100 meeting entitlement. A partial or unavailable coverage status means results cannot establish that the library has been fully searched. Semantic readiness is reported separately from text coverage.

1. Call `search_meetings` with a nonempty `query`. Optional filters narrow servers, dates, voice or text channel, tags and archive state. Read the returned title and complete notes before investigating a transcript.
2. Pass the returned canonical references in `search_transcripts.meetingIds`, for example `[{ "serverId": "<server-id>", "id": "<canonical-meeting-id>" }]`, along with your transcript `query`. An empty meeting set is invalid. Transcript search never searches the whole library without a selected meeting set.
3. Follow `nextCursor` with the same query and filters to load another page. `pageSize` defaults to 10 and permits up to 25 records per page, independently of plan. Use the existing transcript read tool to inspect more of an accessible transcript.

Search applies current meeting access, transcript settings, OAuth scopes and service-account server/channel restrictions. A meeting reference identifies a record; it does not grant access.

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

- `meetings:read`: Required for server lists, meeting lists, meeting search and meeting summaries.
- `transcripts:read`: Required in addition to `meetings:read` for transcript text and transcript search.
- `meetings:start`: Required to start recordings through MCP.
- `meetings:stop`: Required to stop recordings through MCP.
- `get_meeting_control_request` requires a valid MCP token and only returns requests created by the authenticated user.

If a tool returns `insufficient_scope`, your MCP client should follow the `WWW-Authenticate` challenge, run OAuth step-up authorization for the listed scopes, and retry the request. During step-up, Chronote may require a fresh browser authorization instead of refreshing the existing token so the new scopes are explicitly approved. If your client does not support step-up authorization, reconnect Chronote MCP and approve the read, transcript, start, and stop scopes you need.

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
- A server's Transcript access setting can still make completed and live transcripts unavailable, even when the token has `transcripts:read`.
- Starting a live meeting requires the authenticated Discord user to already be in the target voice channel.
- Stopping a meeting requires creator or meeting-management permissions.

Service account tokens run through these same rules, resolved against the bot they act as, plus the server and channel bounds recorded on the token.
