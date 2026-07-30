# Meeting notes eval runner

This CLI runs the notes prompt against a Langfuse dataset and grades how the
generated notes handle Discord mentions.

## Status: cannot run yet

Verified 2026-07-30: the `meeting-notes` dataset does not exist in the Langfuse
project, and there is no code anywhere in this repo that creates a dataset or
uploads items to one. `yarn eval:meeting-notes` therefore fails on
`dataset.get`. The same is true of `yarn eval:meeting-summary`
(`meeting-summary` is absent too); `yarn eval:transcription` works only through
its local `--file` mode.

The mention graders are unit tested (`src/evals/__tests__/roleMentionGraders.test.ts`).
The case format below is only exercised by the runner at runtime: no test parses
`EvalInputSchema` or the sample dataset file, so treat the shape as unverified
until the runner actually executes. What is missing is the seeding step. Closing
that means an upload command that creates a dataset and its items from a case
file, so the harvest output has somewhere to go.

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
private location, curate `expectedOutput`, and strip identifying details.
`*.harvested.json` is gitignored as a backstop.

There is currently no way to get a curated file into Langfuse: no upload command
exists, so harvested stubs have no consumer until the seeding step above is
built. Harvesting is still useful for reading what went wrong by hand.

Cases are grouped by meeting and notes version, since two downvotes on different
versions are different failures. Notes come from the matching `notesHistory`
entry; `notesVersionResolved: false` in metadata means that version was no longer
retained and the current notes were used instead, so the case may not reproduce.

Known limitation: participant chat is not carried into harvested cases. When a
meeting had chat, production renders it into `chatContextInstruction` and
`chatContextBlock`, including any explicit include or omit instruction, and a
harvested rerun falls back to "no chat was captured". A downvote caused by an
ignored chat instruction will not reproduce. The chat log is retained under
`chatS3Key`, so this is recoverable work rather than lost data.

Known limitation: production composes `formattedContext` from server, channel,
and meeting context plus recent history, but only the meeting layer is retained
per meeting. A harvested case carries that layer and not the server or channel
context in force at the time.

Known limitation: the role roster is rebuilt from the guild's **current** roles,
not the roster as it stood during the meeting. Roles are not snapshotted per
meeting (a deliberate simplicity tradeoff), so renamed, deleted, or newly created
roles will shift a harvested prompt away from the original. Harvest and curate
downvotes reasonably soon after they arrive, and treat role-heavy cases from old
meetings with suspicion. Meetings whose guild can no longer be read at all are
skipped with a warning rather than harvested with an empty roster.
