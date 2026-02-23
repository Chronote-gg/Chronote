# Feature Toggles and Evaluation

## Purpose

This document tracks feature toggles and knobs that are candidates for rollout or evaluation. It also calls out permanent product settings so we do not confuse shipping configuration with experiments.

## How to use toggles

- All toggles and knobs live in the config registry and should be adjustable via the config system.
- Use server overrides for evaluation in specific guilds.
- Keep defaults safe, and avoid changing defaults without a clear rollout plan.

## Toggle lifecycle

- Proposal: add a toggle and document an evaluation plan.
- Evaluation: enable in limited servers, capture feedback and metrics.
- Graduate: remove the toggle, or keep it as a permanent setting if it is user facing.
- Retire: remove the feature and toggle when no longer needed.

## Experimental and evaluation toggles

| Key                                               | Default | Scope           | Status        | Evaluation notes                                                                                                           |
| ------------------------------------------------- | ------- | --------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `features.experimental`                           | false   | global, server  | shipping gate | Controls access to experimental settings. Verify gating in settings UI and server snapshots.                               |
| `transcription.premium.enabled`                   | false   | global, server  | experimental  | Enable premium transcription. Validate output quality and latency across tiers.                                            |
| `transcription.premium.cleanup.enabled`           | false   | global, server  | experimental  | Cleanup pass on compiled transcripts. Watch for missing lines or formatting drift.                                         |
| `transcription.suppression.enabled`               | true    | global, server  | evaluation    | Loudness gate that suppresses low-confidence text from quiet audio. Validate false positives before changing defaults.     |
| `transcription.suppression.hardSilenceDbfs`       | -60     | global, server  | evaluation    | Hard silence threshold for suppression. Tune to avoid false positives on quiet speakers.                                   |
| `transcription.suppression.rateMaxSeconds`        | 3       | global, server  | evaluation    | Max snippet length for syllable rate suppression. Tune to capture noisy mic bumps without blocking legit speech.           |
| `transcription.suppression.minWords`              | 4       | global, server  | evaluation    | Minimum word count before applying syllable rate suppression.                                                              |
| `transcription.suppression.minSyllables`          | 8       | global, server  | evaluation    | Minimum syllable count before applying syllable rate suppression.                                                          |
| `transcription.suppression.maxSyllablesPerSecond` | 7       | global, server  | evaluation    | Max syllables per second for short snippets. Tune using Langfuse rate analysis results.                                    |
| `transcription.promptEcho.enabled`                | true    | global, server  | evaluation    | Prompt echo gate that suppresses transcripts repeating the prompt. Validate echo false positives before changing defaults. |
| `transcription.vote.enabled`                      | true    | global, server  | evaluation    | For low-confidence slow snippets, run prompt and no-prompt paths and keep the better candidate.                            |
| `transcription.fastFinalization.enabled`          | false   | global, server  | evaluation    | Skip the slow pass when fast transcript covers the full snippet. Validate cost reduction without quality loss.             |
| `transcription.interjection.enabled`              | false   | global, server  | evaluation    | Finalize paused snippets on interjection to improve ordering. Validate that chatter or noise does not fragment snippets.   |
| `transcription.interjection.minSpeakerSeconds`    | 0.3     | global, server  | evaluation    | Minimum interjection duration before splitting. Tune to avoid noise triggers.                                              |
| `liveVoice.enabled`                               | false   | server, channel | evaluation    | Live voice responder. Validate response timing and user acceptance.                                                        |
| `liveVoice.commands.enabled`                      | false   | server, channel | evaluation    | Voice command handling. Validate intent recognition and safety.                                                            |
| `chatTts.enabled`                                 | false   | server, channel | evaluation    | Chat to speech. Validate that it does not drown out voice capture.                                                         |

## Shipping configuration settings

These are product settings, not experiments. They are included here so we do not mislabel them as evaluation toggles.

| Key                   | Default | Scope           | Purpose                       |
| --------------------- | ------- | --------------- | ----------------------------- |
| `ask.members.enabled` | true    | server          | Allow Ask to use member data. |
| `ask.sharing.policy`  | server  | global, server  | Default Ask sharing policy.   |
| `autorecord.enabled`  | false   | server, channel | Auto record default behavior. |
| `models.<role>`       | varies  | global, server  | Selects the model per role.   |

## Manual evaluation checklist

Use this checklist for new toggles or when tuning defaults.

- Define a target server or channel and the exact config override values.
- Capture before and after results for one or two meetings.
- For transcription toggles, capture ordering issues, missed interjections, and cleanup drift.
- For live voice and chat TTS, capture perceived latency and interruption risk.
- Log any manual test artifacts in the relevant ticket or notes channel.

## Removing a toggle

- Remove the config entry, key constant, and any runtime config wiring.
- Delete UI references if present.
- Update this document and remove evaluation notes.
