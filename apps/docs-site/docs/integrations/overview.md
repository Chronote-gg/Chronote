---
title: Integrations
slug: /integrations
---

Chronote integrations extend meeting data into external tools and workflows.

## Current integrations

### Web portal

Chronote includes a built-in web portal for browsing meetings, reading transcripts, sharing links, and managing settings. The portal is accessible from any meeting summary embed via the **Open in Chronote** button.

The portal authenticates through Discord OAuth so channel permissions are respected.

The portal can also import Markdown or plain-text notes from external tools into an existing meeting. This supports copy/paste workflows from tools like Notion or Obsidian before dedicated sync integrations are available.

### Notion

Chronote can export meeting notes to Notion from the web portal. Connect Notion from the notes actions menu, then choose **Export to Notion** for a meeting. Chronote creates a Notion page from the current meeting notes and stores the page link for quick access.

If Chronote notes are edited later, use **Sync latest to Notion** to replace the exported Notion page with the newest Chronote notes version.

Chronote is the source of truth for this integration. The initial integration is one-way from Chronote to Notion.

### Discord

Chronote's primary interface. All meeting controls, notes, and interactions happen through Discord slash commands, embeds, and buttons. See [Features](/features/) for the full command reference.

### Remote MCP

Chronote exposes a read-only MCP (Model Context Protocol) endpoint for AI assistants and agents. It uses OAuth with Discord sign-in and respects the same meeting access rules as the portal.

See [Remote MCP](/integrations/remote-mcp) for setup and available tools.

## Planned integrations

### Notion automation

Automatic background sync to a configured Notion folder or page is planned. Notion database support is also planned so teams can map meeting metadata (date, attendees, tags, duration, status, and Chronote links) into database properties.

## Integration principles

These principles guide how integrations are built:

- **Chronote is the source of truth.** Integrations push data out; they do not replace data stored in Chronote.
- **Minimal scopes.** Each integration requests only the permissions it needs.
- **Existing auth.** Integrations reuse Chronote's Discord-based authentication and permission model where possible.

Planned integrations will include dedicated setup and configuration documentation when they are released. Check [What's New](/whats-new/) for announcements.
