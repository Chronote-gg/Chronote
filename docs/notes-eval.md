# Meeting notes eval runner

This CLI runs the notes prompt against a Langfuse dataset and grades how the
generated notes handle Discord mentions.

## Seeding a dataset

A dataset has to exist before any runner can use it. Nothing creates one
implicitly.

```bash
yarn evals:upload --dataset meeting-notes --file docs/evals/meeting-notes-eval.dataset.json
```

This creates the dataset if absent and upserts each item. Items upsert on id,
resolved from an explicit `id` field or from `metadata.label`, so re-running the
same file is idempotent rather than duplicating cases. A case with neither gets a
generated id and the command warns that re-uploading will duplicate it.

`meeting-notes` was seeded from the sample file on 2026-07-30 (2 synthetic
cases). A runner pointed at a dataset that does not exist now fails with the
upload command to run rather than a raw `dataset.get` error.

## Running

```bash
yarn eval:meeting-notes
```

Environment:

- `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`.
- **A full app environment.** The runners import `configService`, which validates
  the whole config at module load, so `DISCORD_CLIENT_ID`, `OPENAI_API_KEY`,
  `FRONTEND_SITE_URL`, `OAUTH_SECRET`, and the rest must be present or the
  process exits before touching Langfuse. Langfuse keys alone are not enough.
  `scripts/mock.env.example` is the quickest way to satisfy the non-OpenAI
  values; the OpenAI key has to be real since the eval calls the model.
- `LANGFUSE_EVAL_DATASET` selects the dataset (default `meeting-notes`).
- `LANGFUSE_EVAL_EXPERIMENT` names the run (defaults to a timestamped name).

Pass `--items` to print each case's generated notes and per-case grades.
Aggregate scores tell you a run regressed but not which case or why.

The mention graders are unit tested
(`src/evals/__tests__/roleMentionGraders.test.ts`) and have now been exercised
against live model output: a run on 2026-07-30 over the seeded `meeting-notes`
cases scored 1.000 on all six grades, with the multi-assignment case emitting
both expected role mentions and the expected member mention. Recall over a
non-empty expected set cannot pass unless those mentions are really present, so
that is a real signal rather than a vacuous pass. Note the no-assignment case
has an empty `expectedRoleIds`, which makes its recall grades trivially 1.000;
its value is `role_mentions_resolvable`, proving the model does not invent a
role mention when nothing was assigned to a group.

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

Once curated, load the file with `yarn evals:upload` as above. Give each case a
`metadata.label` so re-uploads upsert rather than duplicating.

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
