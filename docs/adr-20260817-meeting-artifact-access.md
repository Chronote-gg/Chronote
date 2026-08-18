# ADR-20260817: Server Meeting Artifact Access

Status: Accepted

Date: 2026-08-17
Owners: Meeting library and server settings

## Context

Server managers need to limit whether members can retrieve completed meeting
transcripts and audio recordings. A summary is often acceptable where the
source transcript or a replayable voice recording is not.

Chronote currently treats the presence of an S3 key as artifact availability.
That exposes transcripts through the portal, shared meeting pages, exports, and
MCP, and exposes audio through a short-lived portal URL. Storage and viewer
access therefore need separate policy.

## Decision

Add independent server-wide settings for transcript access and audio access.
Both settings default to enabled and use the existing Manage Server permission.

1. A disabled setting applies immediately to existing and future guild-owned
   meetings. No MeetingHistory migration or per-meeting policy snapshot is
   required.
2. Enforcement happens on the server before transcript content or an audio URL
   is returned. Personal meetings are not governed by a server setting.
3. Transcript access covers completed portal views, shared meeting pages,
   exports, MCP transcript retrieval, and new live-transcript connections.
4. Audio access covers portal playback and exports. Shared meeting pages do not
   currently expose audio.
5. Notes and summaries remain available. Chronote still records, transcribes,
   processes, and stores artifacts. Re-enabling access makes stored artifacts
   available again.
6. Notes correction continues to use the transcript internally. The setting
   controls direct artifact retrieval, not derived processing used to maintain
   the summary.
7. A setting change does not terminate an already-open live transcript stream.
   New connections and later requests use the current setting.

## Consequences

Positive:

- Server managers can reduce source-artifact exposure without losing summaries.
- Retroactive enforcement protects existing meeting pages and share links.
- Existing records remain compatible because policy is resolved at read time.

Costs and risks:

- Disabling access is not deletion. Stored artifacts and previously downloaded
  copies remain.
- An audio URL issued before the setting changed remains usable until it expires.
- A live transcript already open when the setting changes remains connected.
- Transcript-off and audio-on can reduce accessibility for members who rely on
  text.

## Alternatives Considered

1. Delete source artifacts after summary generation. Rejected for this change
   because retention is a separate product and infrastructure decision.
2. Store visibility on each MeetingHistory record. Rejected because it requires
   migration and prevents a server manager from immediately protecting existing
   meetings.
3. Add channel or per-meeting overrides. Deferred until server-wide controls
   demonstrate a need for additional granularity.
4. Stop using transcripts for notes correction when viewer access is disabled.
   Rejected because direct access and internal derived processing are separate,
   and removing transcript context would reduce correction quality.

## Notes

Public documentation must state that these settings control availability, not
recording, processing, retention, or deletion. Previously exported or copied
content cannot be recalled.
