# ADR-20260524: Queue Remote MCP Meeting Control Commands

Status: Accepted
Date: 2026-05-24
Owners: Backend and bot runtime

## Context

Remote MCP originally exposed read-only meeting history tools. Live meeting
control needs bot gateway state, voice channel objects, permissions, and the
in-memory meeting owner runtime. The API and bot can run in one process today,
but the project also supports separate API-only and bot-only runtimes. Scaling
recording and transcription work will eventually require multiple bot workers.

## Decision

Add a DynamoDB-backed `MeetingControlCommandTable` for short-lived MCP control
requests:

1. API/MCP tools enqueue start, stop, live-status, and live-transcript commands.
2. Bot workers poll pending commands through `StatusCreatedAtIndex` and claim
   work before execution.
3. Commands that must run on the active meeting owner include
   `targetOwnerInstanceId` from the active meeting lease.
4. The MCP tool returns completed results when available, otherwise a `requestId`
   that can be checked with `get_meeting_control_request`.

## Consequences

Positive:

- API-only and bot-only runtimes can process MCP control without shared memory.
- Future multi-bot scaling can route live meeting commands to the worker that
  owns the voice connection.
- MCP write scopes stay narrow (`meetings:start`, `meetings:stop`).

Costs and risks:

- Meeting control now depends on a DynamoDB queue table and bot worker polling.
- MCP clients must handle occasional pending responses.
- Start commands without a target owner can be claimed by any bot worker, so
  workers must still enforce active meeting leases before joining voice.

## Alternatives Considered

1. Use same-process `getDiscordClient()` from the API. This is simpler but fails
   when API and bot runtimes are split.
2. Add direct API-to-bot HTTP callbacks. This adds service discovery and network
   security concerns before they are needed.
3. Keep Remote MCP read-only. This avoids write risk but does not support the
   desired assistant-driven live meeting workflow.

## Notes

The queue is not a durable audit log. Records expire via DynamoDB TTL, deletion
is eventual, and backup/recovery windows may retain prior versions. Queue records
store only command metadata, results, and errors needed by the MCP client.
