# ADR-20260508: User Meeting Index

Status: Accepted
Date: 2026-05-08
Owners: API and frontend

## Context

Chronote meeting history is stored by Discord server, which works for server
Library views but makes guild-agnostic queries expensive. The My Meetings MCP
tool and portal view need chronological access to meetings for one user across
servers, especially for today and the past week.

## Decision

Add a `MeetingUserIndexTable` keyed by `userId` and a timestamp-prefixed
`userTimestamp` sort key. The table stores pointers to `MeetingHistory` records:
`guildId`, `channelId_timestamp`, `meetingId`, and `timestamp`.

Meeting history writes also write index records for participant IDs, the meeting
creator, and the start-triggering user. Reads use the index as a candidate list
and then fetch `MeetingHistory` before applying current meeting access checks.
The first implementation also keeps a bounded guild-range fallback so meetings
created before the index exists can still appear in short-range My Meetings
queries.

## Consequences

Positive:

- My Meetings can query by user and time without scanning every server first.
- The index stores pointers only, not notes or transcripts.
- Current Discord and Chronote meeting access checks remain authoritative.

Costs and risks:

- Meeting history writes now perform additional DynamoDB writes.
- Pointer records can become stale if future code changes participant snapshots.
- Legacy fallback adds extra reads until old meetings are backfilled or age out of
  common query windows.

## Alternatives Considered

1. Query every accessible server by time for every My Meetings request. This is
   simple but scales poorly as server count and meeting volume grow.
2. Add a GSI on `MeetingHistory` for participants. DynamoDB cannot query inside
   participant arrays directly.
3. Denormalize full meeting summaries into the user index. This speeds list
   reads but duplicates sensitive meeting content and complicates corrections.

## Notes

If My Meetings usage grows, add a one-off backfill job and remove the legacy
fallback after backfill coverage is verified.
