# ADR-20260505: Remote MCP OAuth Server

Status: Accepted  
Date: 2026-05-05  
Owners: API and integrations

## Context

Chronote meeting history is useful to coding agents and assistants, but the data
is sensitive and already governed by Discord membership plus channel access. A
remote MCP integration needs to expose meeting data without sharing Discord
tokens, bypassing channel permissions, or relying on browser session cookies.

MCP remote clients support Streamable HTTP and OAuth. The OAuth protected
resource metadata flow lets clients discover the authorization server, register a
client, complete browser-based consent, and call the MCP endpoint with bearer
tokens bound to the resource URL.

## Decision

Host a Streamable HTTP MCP endpoint on the existing API service at `/mcp`.
Chronote acts as both the OAuth authorization server and MCP resource server:

1. Publish OAuth protected resource metadata for `/mcp`.
2. Support dynamic client registration for public MCP clients.
3. Reuse Discord OAuth for user authentication during authorization.
4. Issue Chronote-owned opaque authorization codes, access tokens, and refresh
   tokens stored hashed in DynamoDB.
5. Bind tokens to `MCP_PUBLIC_BASE_URL + MCP_ENDPOINT_PATH`.
6. Enforce scopes per MCP tool.
7. Require Discord OAuth to be enabled before exposing the remote MCP routes.
8. Reuse existing meeting access checks before returning meeting data.

The first tool set is read-only: server listing, meeting listing, meeting
summary retrieval, and transcript retrieval. Transcript retrieval requires the
additional `transcripts:read` scope.

## Consequences

Positive:

- Agents can retrieve relevant Chronote meeting context through a standard MCP
  interface.
- Discord tokens stay inside the normal web authentication flow.
- OAuth tokens can be revoked or allowed to expire independently of browser
  sessions.
- Existing meeting access rules remain the source of truth.

Costs and risks:

- Chronote now owns OAuth token lifecycle logic and storage.
- Dynamic client registration increases the number of stored OAuth clients.
- Remote clients must implement OAuth and PKCE correctly.
- The MCP endpoint can increase meeting-data read volume.
- OAuth endpoints need abuse controls because dynamic registration is public.

## Alternatives Considered

1. Use browser session cookies for MCP calls. This does not fit most remote MCP
   clients and would blur browser and agent authentication.
2. Pass Discord access tokens directly to MCP clients. This exposes broader
   third-party credentials than needed and couples MCP access to Discord token
   semantics.
3. Use a third-party identity provider for OAuth. This may be useful later, but
   it adds operational complexity before the integration needs external IdP
   federation.
4. Build a local stdio MCP server. This avoids remote OAuth but does not work for
   hosted agents and still needs local secret distribution.

## Notes

Keep future write tools behind narrower scopes and explicit consent. If MCP
usage grows, add per-client rate limits and audit views before exposing broader
meeting-management operations.
