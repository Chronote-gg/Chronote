# Ask agent tools and search records

Review draft, November 17, 2026. This makes the contracts in [the Ask design](2026-11-17-ask-agent-design.md) concrete. These are proposed application contracts, not claims about current Pi or MCP APIs.

## The boundary

Five read-only tools: search_meetings, search_transcripts, list_meetings, read_meeting_notes and read_transcript_passage. Meeting discovery and transcript investigation are distinct operations. No model-visible authentication, subscription tier, index name, raw database/search DSL, arbitrary URL, shell or write operation.

The backend binds the acting user, current scope, timezone, selected context and cancellation signal. Display the current scope and local date/time to the model. Scope changes happen in the UI. All tools and saved evidence recheck current access.

MeetingRef is { serverId: string, id: string }, using the existing service's canonical id (channelId_timestamp), not the separate meetingId UUID. A ref is an address, never authorization. Tools may accept only addresses within their bound scope.

Date bounds are UTC ISO strings: from inclusive, before exclusive. Convert natural-language dates using the supplied user timezone. Server/date/channel/tag filters narrow scope. Tags use all-of, case-normalized matching. Archive is active/all/archived, default active. pageSize defaults 10, maximum 25, independently of tier. Cursors bind the user, scope, filters and query. These are proposed retrieval defaults, not restrictions on eligible history.

serverIds matches any supplied server, intersected with the backend-bound scope and current access. Omitted means all servers in that scope; an explicitly empty list is invalid. Personal-only scope cannot be widened by a server filter. channelId matches either the meeting's resolved voice channel or its resolved text channel. Reuse the existing meeting-access channel resolution, including legacy voice-key and textChannelId-to-notesChannelId fallbacks. Combine filter fields with AND, so serverIds plus channelId means an allowed server AND (voice match OR text match). Channel matching is a retrieval predicate and does not change the authorization policy. A nonexistent or inaccessible server/channel cannot disclose existence through results or counts.

meetingIds is an array of canonical MeetingRef objects, using the same references returned in search/list hits. The name denotes selected meeting identities, not bare IDs that could be ambiguous across servers. Match any supplied reference, intersected with all other filters and current scope/access. It is optional for meeting discovery and mandatory and nonempty for search_transcripts. An explicitly empty array is always invalid. Deduplicate references and include the selected set in cursor binding. Transcript search filters passages to this set before ranking. There is no global transcript search.

The Pi adapter also requires that the current run has received the corresponding title and complete current notes through search_meetings, read_meeting_notes or explicitly loaded selected-meeting context. A list-only metadata result is insufficient until read_meeting_notes is called. Apply the same prerequisite to read_transcript_passage so it cannot bypass the intended flow. Persist provenance with run history and revalidate it on continuation; this workflow rule never substitutes for current access checks. Missing context returns meeting_context_required, directing the agent to read the meeting record first.

## Model arguments

```ts
type MeetingRef = { serverId: string; id: string };

type Filters = {
  serverIds?: string[]; // Any listed server, within the bound scope
  meetingIds?: MeetingRef[]; // Any listed canonical meeting, within other filters
  from?: string;
  before?: string;
  channelId?: string; // Voice channel OR associated text channel
  tags?: string[];
  archive?: "active" | "all" | "archived";
};

search_meetings({
  query: string, // Nonempty natural text; backend performs keyword + semantic search
  filters?: Filters,
  pageSize?: number,
  cursor?: string
});

search_transcripts({
  query: string,
  meetingIds: MeetingRef[], // Required, nonempty, previously loaded meeting records
  pageSize?: number,
  cursor?: string
}); // Always restricted to these meetings AND bound scope/current permissions

list_meetings({
  filters?: Filters,
  pageSize?: number,
  cursor?: string
}); // newest first, deterministic canonical-reference tie break

read_meeting_notes({
  meeting: MeetingRef
});

read_transcript_passage({
  meeting: MeetingRef,
  passageRef?: string, // returned by search or a prior read
  cursor?: string      // continuation; mutually exclusive with passageRef
}); // neither locator means start at beginning
```

Transcript operations enforce artifact permissions and return source_unavailable when a permitted meeting's transcript is disabled, not an empty result suggesting no matches. Search/list page cursors carry the original request; changed filters/query/meeting set require a new first page. The app's direct search picker uses search_meetings, not a global transcript operation.

Meeting search and read_meeting_notes return the title, summary, metadata and complete current notes together. Limit the number of meeting records in a tool result rather than truncating their notes. Transcript reads return one passage, up to approximately 8,000 stored-text characters at paragraph/event boundaries, with continuation. A transcript search passageRef opens a window containing the hit and neighboring text. Transcript read cursors and passageRefs bind the canonical content revision. If content changed, return source_changed and ask the agent to read/search again rather than silently applying old offsets to a new document.

Before delivering a result to Pi, account for the model's remaining context and response reserve. Reduce the delivered meeting page before it exceeds that budget, with a continuation beginning at the first undelivered record. Do not truncate notes or mark an undelivered record as loaded. If even one complete meeting cannot fit, return context_limit with no fabricated empty result or transcript-access eligibility. The agent can compact earlier context or start a fresh conversation and retry; a single record larger than the model's usable context remains explicitly unsupported until a separate product decision. Test both multi-record page reduction and a single oversized record.

These are output sizes, not library limits. The tools can page through an entire document. Offsets are JavaScript UTF-16 stored-string positions, matching the existing transcript service; mention resolution is applied afterward. A passage can be slightly longer after names are resolved. Never derive raw offsets from resolved display text.

## Search and list outputs

search_meetings searches only combined meeting records. Each hit returns its title, summary, metadata and complete current notes, with source revision and citation handle. The proposed S3 Vectors ENHANCED backend combines BM25 and vector retrieval of that meeting dataset using its native hybrid query; no special title/summary boosting or cross-index blending. search_transcripts does the same only for passages within the explicitly selected meetings and returns passage text, parent meeting reference, revision, citation handle, passageRef and continuation. Hydrate all displayed text from canonical records after current access/revision checks. Do not expose engine scores as confidence. A summary helps discovery; it does not prove details absent from the summary.

```json
{
  "hits": [
    {
      "meeting": {
        "serverId": "server-a",
        "id": "channel-a#2026-10-12T14:00:00.000Z"
      },
      "title": "Onboarding review",
      "startedAt": "2026-10-12T14:00:00.000Z",
      "tags": ["onboarding"],
      "archived": false,
      "summary": "Review of the onboarding checklist.",
      "notes": "We agreed to trial the shorter onboarding checklist.",
      "notesRevision": "notes:4",
      "evidenceId": "S1",
      "transcriptAvailable": true
    }
  ],
  "nextCursor": null,
  "coverage": { "status": "ready", "through": "2026-11-17T15:00:00.000Z" }
}
```

Identifiers, timestamps and short complete notes above are synthetic. Transcript search excerpts are capped at roughly 600 characters. Only content revalidated against current source revision/access reaches the caller. Meeting search does not truncate notes to this excerpt size.

list_meetings returns { meetings, nextCursor, coverage } with meeting metadata and notes/transcript availability, without full notes. It uses existing canonical date-browse services, so its coverage reflects that service rather than falsely depending on index readiness. Use read_meeting_notes on a listed meeting before investigating its transcript. No attendee roster or raw Discord message IDs in list/search results.

coverage.status is ready, partial or unavailable; through may be absent when unknown. Add semanticStatus: ready, partial or unavailable when embeddings are pending, oversized or failed; this is distinct from text-index coverage. Live Sandbox qualification confirmed a keyword-only query over previously indexed records can survive an injected query-embedding outage. AWS rejected a new record without vector data. Proposed publication is therefore pending-index with retry for new/changed records until valid embeddings exist, rather than claiming immediate lexical availability; this remains a product-review point in the design. Do not expose index-wide totals or ingestion metadata from unrelated scopes. Use null nextCursor only for exhaustion of authorized results; partial work uses a continuation or explicit partial state. Mixed-model vectors are never searched together.

## Read output and citation handling

```json
{
  "meeting": {
    "serverId": "server-a",
    "id": "channel-a#2026-10-12T14:00:00.000Z"
  },
  "title": "Onboarding review",
  "startedAt": "2026-10-12T14:00:00.000Z",
  "source": "transcript",
  "revision": "transcript:content-hash",
  "evidenceId": "S2",
  "text": "Let's trial the shorter checklist for the next cohort.",
  "location": { "start": 12000, "end": 12061 },
  "nextCursor": "opaque-versioned-continuation",
  "capture": { "status": "available" }
}
```

Use existing capture-quality projections rather than treating stored text as proof of complete audio coverage. Return a real eventId/time location only when it exists in the canonical transcript and mapping; otherwise cite the meeting/passage without inventing an event link.

evidenceId is a run-issued citation handle, not an access credential. Store its mapping to canonical ref, revision, passage and any real eventId privately with run history. The adapter maps validated handles to existing Ask citation rendering. Reject model-created handles and event IDs. The backend builds URLs; the model does not invent them. Search snippets may support narrow claims; read tools supply fuller evidence for summaries and comparisons.

All tools use one error envelope: { error: { code, message, retryable } }. Codes: invalid_argument, not_available (missing, outside scope or denied), source_unavailable (permitted meeting but unavailable artifact), source_changed, meeting_context_required, context_limit, invalid_cursor, temporarily_unavailable. User-safe messages never reveal another scope's existence. Abort is handled as stopped by the run owner, not retried as a failed search.

## Index content

Two logical document classes, in one engine if practical. The meeting index has exactly one record per meeting containing title, summary, metadata and complete current notes. Do not split or truncate notes for indexing. Transcript passages are searched separately, only within the required meeting set. Physical indexes are an engine implementation choice, not a requirement to operate separate services. Artifact filters exclude transcript content before matching and ranking. No combined search, cross-index weights or transcript fallback outside an explicit meeting set.

| Record                          | Searchable text                                                                                                      | Filter/location/version fields                                                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meeting record, one per meeting | Current meetingName, summarySentence, summaryLabel, tags, concise human-readable metadata and complete current notes | Canonical ref, server/personal ownership scope, resolved voiceChannelId and textChannelId, timestamp, archived state, document kind, notes revision and metadata/summary/content hashes |
| Transcript passage              | Stored transcript text split at event/paragraph boundaries, with neighboring overlap                                 | Same canonical metadata including server and both channel IDs, transcript revision/hash, source offsets, actual event/time mapping where present                                        |

Keep searchable title/summary/tag text in the meeting record rather than repeating it in every transcript passage and multiplying its contribution. Transcript passages retain server/channel/date/tag filter fields and the parent reference. Their hits receive display titles only after canonical authorization. Use the existing persisted summarySentence and summaryLabel fields, not a new LLM summarization call during indexing. If a summary is missing, index the title, metadata and complete notes normally; do not invent one or block indexing. Notes corrections, summary edits and renames replace the combined meeting record independently of transcript bodies. Derived summaries are discovery aids, while detailed factual claims should be checked against notes/transcripts.

Separate transcript matching/ranking from notes eligibility so restricted transcript content cannot affect meeting rank or counts. Permission predicates must cover channel, attendee override and personal sharing semantics, not just server membership.

For transcripts only, start with passages around 3,000 stored-text characters and roughly 300 characters overlap. Keep real event boundaries and mappings; both document classes cover the complete text, including notes after character 900. Tune against long meetings and mixed language fixtures. Index display names only through the existing mention resolver; retain raw-to-source mapping and refresh derived name text when needed. Do not treat an old indexed name as current identity. Read-tool output pagination remains separate from index document shape.

Store the original text location/hash outside display normalization so evidence can always be read from canonical DynamoDB/S3 content. Index access metadata is a filtering hint; current application authorization remains authoritative. No source bytes, snippets, metadata, count or score is returned before authorization and version validation. For fields whose live policy cannot be expressed safely before ranking, partition candidate retrieval by the currently authorized artifact/channel set rather than using a global top-N then filtering it.

Do not index audio blobs, prior notes versions, deleted records, Ask chats, prompts, dictionary definitions, OAuth/session data, signed S3 URLs, billing data or complete attendee profiles. Audio already has transcript text; older notes versions and chat memory are separate product questions.

The index is a private derived copy of customer content. It needs encryption, scoped backend-only access, retention/deletion handling and privacy documentation. Changed titles, notes, tags, transcripts and sharing/archive state are projected durably. Deleted sources produce versioned tombstones. Search never relies on the model to filter private hits.

## Concrete example

For "What changed about onboarding after the October review?":

1. search_meetings with query onboarding and October/November bounds, returning titles, summaries, metadata and complete notes together.
2. Inspect those records. If meetings were found via list_meetings or a direct link instead, read_meeting_notes first.
3. If the notes omit the detail, call search_transcripts with the checklist term and required meetingIds, then read the matching passage. To widen the investigation, discover/load additional meeting records first; never fall back to global transcript search.
4. Answer with the issued evidence handles, and state when a conclusion lacks evidence.

The same meeting search service powers the user's picker and public MCP. Transcript search always requires a meeting set at the shared-service boundary. Pi additionally enforces the meeting-record-first prerequisite; public MCP adapters retain their own transport contract rather than importing Pi run state. List/read reuse the existing MCP-backed service implementations. Full-text retrieval, versioned passages and citation-handle normalization are the actual additions.

Tradeoff: a fact present only in a transcript cannot directly discover a meeting whose title/notes do not mention it. The agent must broaden meeting queries, browse dates or use user-selected meetings before investigating those transcripts. This is the intended product flow, not an indexing coverage failure.

## Remaining implementation choices

S3 Vectors ENHANCED remains the proposed backend, using meetings and transcript_passages indexes in an environment-specific vector bucket. Dimension 1,536, float32, cosine; text-embedding-3-small is the model recommendation, with 3-large at the same dimension as the comparison. Live synthetic qualification and actual retained-record sizing are recorded in the main design; remaining lifecycle/pagination/IaC/model-quality checks are distinct. No SQL database, application-side hybrid-rank fusion, global transcript query or model-supplied filter DSL. Existing tool arguments and meeting-record-first behavior remain unchanged. Qualification resources were temporary and cleaned up; no product integration/runtime has shipped.
