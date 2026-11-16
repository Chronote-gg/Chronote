# Dictionary Feature

## Overview

The dictionary feature lets server admins add domain terms and optional definitions so transcription, cleanup, notes, summaries, and Ask can interpret jargon consistently. Definitions are optional and are hidden behind an explicit action in the UI to keep entry creation fast.

## Product decisions

- Scope: Dictionary entries are server scoped and shared across channels in the same guild.
- Definition optional: A term can be stored with or without a definition. The UI shows one input by default and reveals the definition field only when requested.
- Prompt usage: Speech recognition receives terms only, as keyword hints, while cleanup, notes, and Ask receive terms with definitions when provided.
- Budgeting: Prompt budgets are capped by entry count and character limits, with base and pro tiers and hard caps to avoid prompt bloat.

## Technical decisions

- Storage: `DictionaryTable` in DynamoDB with `guildId` as the hash key and `termKey` as the range key.
- Normalization: `termKey` is a normalized, lowercased term with collapsed whitespace. Entries are deduped by `termKey`.
- Ordering: Most recently updated entries are used first when building prompt lines.
- Constraints: Term length max 80, definition length max 400.
- Budgets: Config keys drive entry caps and character budgets for transcription keywords and context prompts, plus tier based overrides and global caps. Transcription is also capped at 20 terms per request (see `docs/adr-20261116-transcription-simplification.md`).

## Prompt usage summary

- Transcription: `gpt-transcribe` requests carry the terms as `keywords`, without definitions, when the speech detector judged the snippet to be speech. Terms containing `<`, `>` or a line break are skipped because the API rejects the whole request for them. Models without keyword support receive none.
- Cleanup, notes: Uses a `Dictionary` block with terms and definitions.
- Ask: Uses a `Dictionary` block alongside meeting context blocks to interpret proper nouns.

## Future ideas

- Optional automation that suggests dictionary entries from corrections or frequently corrected terms.
- LLM based pruning or selection of dictionary terms per meeting before injecting into prompts.
- Dictionary packs: curated sets of terms by domain or interest (for example, gaming, sales, engineering). Packs could be selectable during onboarding or later via search, with popular packs surfaced first. We can also suggest packs based on meeting notes or tags, or promote packs as a lightweight marketing prompt. Packs should be easy to preview and apply, and their terms should remain editable after import.
