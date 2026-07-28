# Meeting notes eval runner

This CLI runs the notes prompt against a Langfuse dataset and grades how the
generated notes handle Discord mentions.

## Running

```bash
yarn eval:meeting-notes
```

Environment:

- `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are required.
- `LANGFUSE_EVAL_DATASET` selects the dataset (default `meeting-notes`).
- `LANGFUSE_EVAL_EXPERIMENT` names the run (defaults to a timestamped name).

## Case shape

Cases carry rendered prompt variables rather than a `MeetingData` object, so a
case can be written by hand without reconstructing Discord state. Only
`transcript`, `participantRoster`, and `roles` are required; everything else
falls back to a neutral default.

```json
{
  "input": {
    "transcript": "User A: ...",
    "participantRoster": "- User A | ... | mention: <@200000000000000001> | roles: Design",
    "roles": "- Design | mention: <@&300000000000000001> | in this meeting: 1",
    "allowedUserIds": ["200000000000000001"],
    "allowedRoleIds": ["300000000000000001"],
    "guildId": "100000000000000001"
  },
  "expectedOutput": {
    "expectedUserIds": ["200000000000000001"],
    "expectedRoleIds": ["300000000000000001"]
  }
}
```

Build roster strings with `formatParticipantRoster` and `formatRoleRoster` from
`src/services/notesPromptService.ts` so a case matches what the bot actually
sends. Sample payloads live in `docs/evals/meeting-notes-eval.dataset.json`.

## Grades

Mention grading is deterministic (`src/evals/roleMentionGraders.ts`), so no judge
model is involved:

- `notes_present`: the model returned non-empty notes.
- `role_mentions_resolvable` / `user_mentions_resolvable`: every mention id in the
  output appeared in the rosters. This is the grade that catches an invented id.
- `no_broadcast_mention`: the output avoided `@everyone`, `@here`, and the
  `@everyone` role id (which equals the guild id).
- `expected_role_recall` / `expected_user_recall`: fraction of the ids a case
  expects that actually appeared. Omitted when a case declares no expectations.

## Harvesting cases from downvoted meetings

```bash
yarn evals:harvest-downvotes --output ../chronote-ops/notes-cases.harvested.json
```

Reads downvoted meeting summaries from the feedback table and writes eval case
stubs with `expectedOutput` left blank, plus the original generated notes and the
downvote comment in `metadata` for context.

`--output` is required and has no default inside this repo on purpose: stubs
contain real meeting content, and this repository is public. Write them to a
private location, curate `expectedOutput`, strip identifying details, then upload
to Langfuse. `*.harvested.json` is gitignored as a backstop.

Cases are grouped by meeting and notes version, since two downvotes on different
versions are different failures. Notes come from the matching `notesHistory`
entry; `notesVersionResolved: false` in metadata means that version was no longer
retained and the current notes were used instead, so the case may not reproduce.

Known limitation: the role roster is rebuilt from the guild's **current** roles,
not the roster as it stood during the meeting. Roles are not snapshotted per
meeting (a deliberate simplicity tradeoff), so renamed, deleted, or newly created
roles will shift a harvested prompt away from the original. Harvest and curate
downvotes reasonably soon after they arrive, and treat role-heavy cases from old
meetings with suspicion. Meetings whose guild can no longer be read at all are
skipped with a warning rather than harvested with an empty roster.
