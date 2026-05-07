---
title: Integrations
slug: /integrations
---

Chronote integrations extend meeting data into external tools and workflows.

## Current integrations

### Web portal

Chronote includes a built-in web portal for browsing meetings, reading transcripts, sharing links, and managing settings. The portal is accessible from any meeting summary embed via the **Open in Chronote** button.

The portal authenticates through Discord OAuth so channel permissions are respected.

### Discord

Chronote's primary interface. All meeting controls, notes, and interactions happen through Discord slash commands, embeds, and buttons. See [Features](/features/) for the full command reference.

### Remote MCP

Chronote exposes a read-only MCP (Model Context Protocol) endpoint for AI assistants and agents. It uses OAuth with Discord sign-in and respects the same meeting access rules as the portal.

See [Remote MCP](/integrations/remote-mcp) for setup and available tools.

## Planned integrations

### Notion

Push meeting notes to a Notion database, with one row per meeting. This integration will sync meeting metadata (date, attendees, tags, duration) alongside the notes content.

## Integration principles

These principles guide how integrations are built:

- **Chronote is the source of truth.** Integrations push data out; they do not replace data stored in Chronote.
- **Minimal scopes.** Each integration requests only the permissions it needs.
- **Existing auth.** Integrations reuse Chronote's Discord-based authentication and permission model where possible.

Planned integrations will include dedicated setup and configuration documentation when they are released. Check [What's New](/whats-new/) for announcements.
