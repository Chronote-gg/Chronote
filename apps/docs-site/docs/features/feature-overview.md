---
title: Features
slug: /features
---

This page is a reference for every Chronote command and feature. Each section describes what the feature does, how to use it, and what to expect.

## Slash commands

### `/startmeeting`

Starts a recorded meeting in the voice channel you are currently in.

| Option    | Required | Description                                |
| --------- | -------- | ------------------------------------------ |
| `context` | No       | Describe the meeting topic (max 500 chars) |
| `tags`    | No       | Comma-separated tags (max 500 chars)       |

**Requirements**: You must be in a voice channel. The bot needs Connect and Speak permissions in that voice channel, and View Channel and Send Messages in the text channel. No other meeting can be active in the server.

**Output**: A "Meeting Started" embed with End Meeting, Edit Tags, and Live Transcript buttons.

### `/autorecord`

Configures automatic recording for voice channels. Requires **Manage Channels** permission.

| Subcommand    | Options                                 | Description                            |
| ------------- | --------------------------------------- | -------------------------------------- |
| `enable`      | `voice-channel`, `text-channel`, `tags` | Auto-record a specific voice channel   |
| `disable`     | `voice-channel`                         | Stop auto-recording a specific channel |
| `enable-all`  | `text-channel`, `tags`                  | Auto-record every voice channel        |
| `disable-all` | (none)                                  | Turn off server-wide auto-recording    |
| `list`        | (none)                                  | Show all auto-record rules             |

When auto-record is enabled, Chronote starts recording automatically whenever someone joins the configured voice channel. Notes are posted to the specified text channel.

After a meeting is explicitly ended, auto-record is suppressed for that channel until it fully empties, preventing an immediate re-recording loop.

### `/context`

Manages context that is injected into transcription and notes prompts. Requires **Manage Channels** permission.

| Subcommand      | Options                    | Description                              |
| --------------- | -------------------------- | ---------------------------------------- |
| `set-server`    | `context` (max 2000 chars) | Set server-wide context                  |
| `set-channel`   | `channel`, `context`       | Set context for a specific voice channel |
| `view`          | `channel` (optional)       | View current context settings            |
| `clear-server`  | (none)                     | Remove server-wide context               |
| `clear-channel` | `channel`                  | Remove context for a channel             |
| `list`          | (none)                     | List all context settings                |

Context helps the AI understand your domain. For example, setting server context to "Backend engineering team at Acme Corp working on the Rocket API" tells the model what kind of conversations to expect.

Context stacks: server context applies to all meetings, channel context applies to meetings in that channel, and meeting context (from `/startmeeting`) applies to that specific meeting.

### `/dictionary`

Manages a glossary of terms that are injected into prompts. Requires **Manage Channels** permission.

| Subcommand | Options                                                       | Description                     |
| ---------- | ------------------------------------------------------------- | ------------------------------- |
| `add`      | `term` (max 80 chars), `definition` (optional, max 400 chars) | Add or update a term            |
| `remove`   | `term`                                                        | Remove a term                   |
| `list`     | (none)                                                        | List all terms (up to 20 shown) |
| `clear`    | (none)                                                        | Remove all terms                |

All responses are ephemeral (visible only to you).

Dictionary terms are injected into the transcription prompt so the AI spells them correctly. Definitions are included in the notes prompt (but not the transcription prompt) to give the AI additional context without bloating the transcription input.

**Examples of useful dictionary entries:**

- `Kubernetes` (no definition needed, just ensures correct spelling)
- `LGTM` with definition `Looks Good To Me, a code review approval`
- `Jane Smith` with definition `Engineering manager, backend team`

### `/ask`

Ask natural-language questions about past meetings.

| Option     | Required | Description                                                |
| ---------- | -------- | ---------------------------------------------------------- |
| `question` | Yes      | Your question                                              |
| `tags`     | No       | Filter by tags                                             |
| `scope`    | No       | "Guild" (default, searches all channels) or "Channel only" |

Chronote searches your meeting history and generates an answer with citations linking to specific meetings. The number of meetings searched depends on your plan tier.

### `/tts`

Controls text-to-speech for your chat messages during meetings.

| Subcommand | Options                               | Description                           |
| ---------- | ------------------------------------- | ------------------------------------- |
| `enable`   | (none)                                | Your chat messages are spoken aloud   |
| `disable`  | (none)                                | Stop speaking your messages           |
| `voice`    | `voice` (pick from list or "default") | Choose a TTS voice                    |
| `stop`     | (none)                                | Stop current playback and clear queue |

When enabled, any message you send in the meeting text channel is spoken aloud in the voice channel. This is useful for remote participants who cannot speak.

### `/say`

Speak a single message aloud in the meeting voice channel.

| Option    | Required | Description       |
| --------- | -------- | ----------------- |
| `message` | Yes      | The text to speak |

Unlike `/tts`, this is a one-shot command. It does not enable ongoing text-to-speech.

### `/billing`

Manage your server's Chronote subscription. Opens the Stripe billing portal for plan management.

### `/onboard`

Launches a guided setup wizard for new servers. Requires **Manage Server** permission. Walks through selecting a notes channel, setting context, and adding dictionary terms.

Can be disabled server-wide after initial setup.

## Button interactions

These buttons appear on meeting embeds:

| Button             | When it appears       | What it does                                         |
| ------------------ | --------------------- | ---------------------------------------------------- |
| End Meeting        | During active meeting | Stops recording and begins processing                |
| Edit Tags          | During and after      | Opens a modal to edit meeting tags                   |
| Live Transcript    | During active meeting | Links to the real-time transcript on the web portal  |
| Open in Chronote   | After meeting ends    | Links to the meeting in the web portal               |
| Helpful            | After meeting ends    | Positive feedback on notes quality                   |
| Needs work         | After meeting ends    | Negative feedback on notes quality                   |
| Suggest correction | After meeting ends    | Opens the notes correction flow (see below)          |
| Rename meeting     | After meeting ends    | Opens a modal to rename the meeting                  |
| Generate Image     | After meeting ends    | Creates a DALL-E image from the meeting (plan-gated) |

## Notes correction flow

1. Click **Suggest correction** on a meeting summary.
2. A modal appears with a text field. Describe what should change (up to 1500 characters). For example: "The decision was to use PostgreSQL, not MySQL" or "Add the action item for Jake to update the API docs."
3. Chronote reads the saved transcript and current notes, then generates a minimal correction. A line diff is shown.
4. An authorized reviewer clicks **Accept & update** or **Reject**.

**Who can approve**: The meeting creator for manual meetings. Anyone with Manage Channels for auto-recorded meetings.

Accepted corrections:

- Replace the notes embeds with updated content.
- Increment the notes version (shown in the footer as "v2", "v3", etc.).
- Record the editor and suggestion in the history.

Each correction uses the transcript as ground truth, so the AI cannot fabricate content that was not actually discussed.

## Meeting image generation

After a meeting ends, click **Generate Image** to create a DALL-E-generated visual summary. The image is based on the meeting transcript and context.

This feature requires a Basic plan or higher.

## Web portal

The Chronote web portal provides a browser-based interface for:

- Browsing meeting history with search and filters.
- Reading full transcripts and notes.
- Sharing meeting links with teammates.
- Suggesting and applying notes corrections.
- Managing server settings (context, dictionary, auto-record).

Access the portal from the **Open in Chronote** button on any meeting summary, or visit your server's portal URL directly.

## Context menu commands

Right-click a user in the voice channel to access:

- **Dismiss Auto-Record**: Prevents the auto-record from restarting when this user is the trigger.
