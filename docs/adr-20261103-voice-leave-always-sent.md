# ADR-20261103: Always Send the Voice Leave While the Guild Is Owned

Status: Superseded by adr-20261111-lifecycle-simplification  
Date: 2026-11-03  
Owners: Meeting lifecycle

## Context

Owned voice settlement withheld the gateway voice leave whenever the operation
had been marked ambiguous. Routine events marked it ambiguous: any shard
disconnect, reconnect, resume or ready during the meeting, a stale gateway
sequence after a re-identify, or a voice session id change. Gateway resumes are
common in long meetings, so the bot often finished delivering notes and then
stayed in the voice channel. Settlement then came back `uncertain`, the durable
`VOICE#<guild>` row blocked new meetings in that guild on every instance, and
the in-memory meeting kept renewing its lease.

The leave was withheld to avoid moving a newer owner's voice session during a
deployment handoff. A newer owner can only reserve a guild once its voice row
is absent or `settled`, so while this instance still owns an unsettled row no
other Chronote runtime can be in voice there.

## Decision

1. At settlement, once earlier sends have drained inside the deadline, send one
   voice leave (`VoiceStateUpdate` with `channel_id: null`) through the tracked
   transport, then destroy the local connection without the SDK sending
   anything. Shard events and session or sequence changes no longer prevent it.
2. Settle when Discord reports the bot outside voice in that guild: a raw
   `VOICE_STATE_UPDATE` for the bot with `channel_id: null` seen after the
   leave, or, if none arrives, one fresh REST read of the bot's voice state
   (`Unknown Voice State` or a null channel) inside the same deadline.
3. Unchanged: the voice row and lease remain the single-owner fence, the
   adapter stays sealed after close, and rejected, pending or cancelled sends
   and failed persistence still leave the guild `uncertain`.

## Consequences

Positive:

- The bot leaves the channel after a gateway resume or reconnect.
- Guilds are no longer blocked by routine gateway events.

Negative:

- A REST read now counts as settlement proof, which the earlier design
  rejected. A lagging REST read can only produce a false `uncertain`.
- A rejected send still holds the guild until operator reconciliation.

## Alternatives Considered

- Keep the session and sequence acknowledgment rule and stop treating shard
  events as ambiguous. Rejected: a re-identify restarts the sequence and can
  change the session, so the acknowledgment would still fail to match.
- Add a time-based expiry to `uncertain` holds. Deferred to the broader
  handoff simplification.

## Notes

- Existing `uncertain` rows from before this change need operator
  reconciliation; this change does not clear them.
- The voice leave on close survives in [ADR-20261111](adr-20261111-lifecycle-simplification.md); the durable voice row, settlement and `uncertain` state it fenced do not exist there.
