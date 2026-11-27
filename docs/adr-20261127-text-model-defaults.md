# ADR-20261127: Text Model Defaults

Status: Accepted  
Date: 2026-11-27  
Owners: Notes pipeline

## Context

The text roles defaulted to `gpt-6.1-sol`, `gpt-6.1-terra` and `gpt-4o-mini`.
OpenAI released `gpt-6.2-sol` on 2026-11-02 at the `gpt-6.1-sol` price.
`gpt-4o-mini` was still the default for image captions, Ask and the live voice
responder. Production pins every text role in the global AppConfig to a 5.6
model, and its Terraform task environment sets `NOTES_MODEL=gpt-5.2` and
`LIVE_VOICE_RESPONDER_MODEL=gpt-4o-mini`.

## Decision

- Notes (`NOTES_MODEL` fallback), meeting summary, notes correction,
  transcription cleanup and image prompt default to `gpt-6.2-sol`. It shares the
  `gpt-6.1-sol` profile: it accepts reasoning `low` to `max` and rejects
  `none`, `minimal` and temperature, so temperature-mode roles send low
  reasoning. Notes request the explicit 30-minute cache control.
- Ask, the live voice responder (`LIVE_VOICE_RESPONDER_MODEL` fallback) and
  dictionary teaching default to `gpt-6.1-terra`.
- The live voice gate and auto-record cancellation (`LIVE_VOICE_GATE_MODEL`
  fallback) and image captions default to `gpt-6-luna`.
- `gpt-4o-mini` is retired as a chat model. It is no longer selectable. A
  stored server override or AppConfig value naming it resolves to the role
  default with one warning instead of failing the config snapshot, a meeting's
  saved choice runs on the default, a recording frozen on it recovers on the
  default with parameters for that model, and an environment variable naming
  it is ignored. The text-to-speech model `gpt-4o-mini-tts` is unrelated and
  unchanged.

## Consequences

Code defaults apply only where nothing pins a role. After this deploys, the
owner changes or removes the global AppConfig `models.*` pins. The global
config must never name a model the deployed code does not list, so a new model
lands in code first and in config second. Until the Terraform variables
change, production notes default to `gpt-5.2` when `models.notes` is unpinned.

## Alternatives Considered

- Keep `gpt-4o-mini` selectable. Rejected by the owner.
- Fail on a stored retired value. Rejected because one bad value fails the
  whole snapshot, as found for transcription models in PR 633.

## Notes

The change had one live smoke call per role on its new default (request
accepted, output parses), not a quality evaluation. On `gpt-6-luna` the gate
used 13 to 42 reasoning tokens of its 256-token cap and auto-record
cancellation 15 to 41 of its 120-token cap, over five calls each.
