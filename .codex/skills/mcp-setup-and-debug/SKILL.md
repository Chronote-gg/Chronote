---
name: mcp-setup-and-debug
description: Configure and debug MCP servers for OpenCode, Codex CLI, and Claude Code, including auth headers, scope, and validation checks. Use when MCP tools fail to connect or when adding a new MCP server.
---

# MCP Setup And Debug

## Overview

Add or fix MCP server configs across OpenCode, Codex, and Claude Code. Confirm endpoints, auth headers, scopes, and validate with each client command.

## Workflow

### 1) Confirm endpoints and auth requirements

- Identify the MCP endpoint and transport. For Langfuse Prompt MCP (US) use `https://us.cloud.langfuse.com/api/public/mcp` with Basic auth. For Langfuse Docs MCP use `https://langfuse.com/api/mcp` with no auth.
- Use web search to verify URLs and required headers if unsure.

### 2) Prepare auth header (when required)

- Use `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in `.env.local`, then run `node scripts/setup-langfuse-mcp-auth.js` to generate `.opencode/langfuse.mcp.auth`, `.opencode/langfuse.public`, and `.opencode/langfuse.secret` for OpenCode.
- Codex and Claude Code still expect `LANGFUSE_MCP_AUTH` in the environment.
- Keep credentials out of repo files.

### 3) Configure each client

- **OpenCode**: add a remote MCP server in `opencode.json` under `mcp`.
  - Include `headers` and set `oauth` to `false` for API key based servers.
  - For local MCP servers that run via uvx, use `type: "local"` and `command: ["uvx", "--python", "3.11", "langfuse-mcp", "--read-only", "--tools", "traces,observations"]`.
  - Validate with `opencode mcp list`.
- **Codex CLI**: add entries in `.codex/config.toml` or `~/.codex/config.toml`.
  - For HTTP servers, use `env_http_headers` to pull `LANGFUSE_MCP_AUTH` from the environment.
  - Validate with `node scripts/mcp-env.js codex mcp list` and `/mcp` in the TUI.
- **Claude Code**: add entries in `.mcp.json` or use `claude mcp add --transport http`.
  - Validate with `node scripts/mcp-env.js claude mcp list` and `/mcp` inside Claude Code.

### 4) Debug checklist

- 401 Unauthorized usually means the auth header is missing or malformed.
- HTML or 404 responses often mean the URL is wrong or OAuth was attempted on a non OAuth server.
- For OpenCode, set `oauth: false` when using API keys.
- Confirm environment variables are available to the client process.

### 5) Report status

- Summarize which clients connect and which fail.
- Provide the exact error text for each failing client and propose the next fix.
