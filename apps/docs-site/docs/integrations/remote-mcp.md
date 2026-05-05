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

## Available Tools

- `list_servers`: Lists Discord servers where the authenticated user can access Chronote data.
- `list_meetings`: Lists recent meetings in a server, with optional channel, date, tag, and archived filters.
- `get_meeting_summary`: Returns notes and metadata for one accessible meeting.
- `get_meeting_transcript`: Returns transcript text for one accessible meeting.

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

Chronote only returns meeting data if the authenticated Discord user can access the meeting. Access follows the same model as the Library:

- Meeting participants can access their meetings when attendee access is enabled.
- Other users need access to the voice channel and notes channel history.
- Transcript access requires explicit transcript scope consent.

Future write tools will use narrower scopes and separate consent.
