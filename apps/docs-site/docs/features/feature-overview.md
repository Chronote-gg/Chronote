---
title: Features
slug: /features
---

This page is a reference for every Chronote command and feature. Each section describes what the feature does, how to use it, and what to expect.

## Slash commands

### `/startmeeting`

Starts a recorded meeting in the voice channel you are currently in. You can also right-click Chronote and select **Apps** -> **Start meeting** to start without context or tags.

| Option    | Required | Description                                |
| --------- | -------- | ------------------------------------------ |
| `context` | No       | Describe the meeting topic (max 500 chars) |
| `tags`    | No       | Comma-separated tags (max 500 chars)       |

**Requirements**: You must be in a voice channel. The bot needs Connect and Speak permissions in that voice channel, and View Channel, Send Messages, and Read Message History in the text channel. No other meeting can be active in the server.

**Output**: A "Meeting Started" embed with End Meeting and Edit Tags buttons, plus a Live transcript button when the Chronote portal is configured.

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

## Importing external notes

If you took notes in another app, open the meeting in the web portal and choose **Import notes** from the notes actions menu.

Imported notes can:

- Replace the current Chronote notes.
- Append under an **Imported notes** section.
- Include an optional source name and URL for traceability.

Imports are saved as a new notes version and update the posted Discord notes when possible.

## Exporting notes to Notion

Open a meeting in the web portal and choose **Export to Notion** from the notes actions menu. If Notion is not connected yet, Chronote starts the Notion authorization flow first.

After export, Chronote stores the Notion page link on that meeting for your user account. If Chronote notes are edited later, choose **Sync latest to Notion** to replace the Notion page content with the newest Chronote notes version.

Server managers can configure automatic Notion export from **Server settings** -> **Notion integration**. Choose a shared destination page, turn on automatic export, and optionally limit exports to selected voice channels or tags. Meeting viewers can open the automated Notion page from the meeting detail when they have access to the Chronote meeting.

You can also configure personal Notion automation from **My Meetings**. Personal automation exports personal uploads and other personal meetings to your Notion destination. Shared viewers can export their own manual copy, but only the personal meeting owner can manage or retry owner automation.

If automated export fails because Notion access was revoked or the destination is unavailable, Chronote keeps the automation setting and shows the latest error in Settings and the Library. A server manager can reconnect Notion, choose a new destination, or retry the export from the meeting actions.

Chronote remains the source of truth. Notion export and sync are one-way from Chronote to Notion.

## Meeting image generation

After a meeting ends, click **Generate Image** to create a DALL-E-generated visual summary. The image is based on the meeting transcript and context.

This feature requires a Basic plan or higher.

## Web portal

The Chronote web portal provides a browser-based interface for:

- Browsing meeting history with search and filters.
- Viewing **My Meetings** as your portal home, with All time results, a **Load more** control for older meetings, and direct links to meetings across servers you can access.
- Uploading personal audio or video files for transcription and notes.
- Configuring personal Notion automation for uploaded and personal meetings.
- Reading full transcripts and notes.
- Sharing meeting links with teammates.
- Suggesting and applying notes corrections.
- Importing Markdown or plain-text notes from another app.
- Managing server settings (context, dictionary, auto-record, Notion automation).

Access the portal from the **Open in Chronote** button on any meeting summary, or open the portal directly to start from **My Meetings**. Use **Upload media** to create a personal meeting from a local recording. Use **View servers** or the server switcher when you want to choose a server for Library, Ask, Billing, or Settings.

## Personal media uploads

Use **Upload Media** in the web portal to turn an existing audio or video file into a personal Chronote meeting.

1. Open the portal and choose **Upload Media** from the sidebar, or **Upload media** from **My Meetings**.
2. Choose an audio or video file.
3. Optionally add a title and comma-separated tags.
4. Click **Upload and process**.
5. Keep the page open until the upload finishes. Chronote will continue processing after the file is received.

When processing completes, the meeting appears in **My Meetings** under your personal workspace. Uploaded personal meetings are owned by your Chronote account, not by a Discord server.

## Chronote Desktop recordings

Chronote Desktop records a personal meeting directly from a Windows computer. It captures your microphone as **Me**, captures system audio as **System/Other**, uploads both sources to Chronote, and creates a personal meeting in **My Meetings**.

Chronote Desktop is currently available as a limited beta. Your account must have desktop access enabled before sign-in and upload will work.

1. Open Chronote Desktop.
2. Sign in with Chronote. The app opens your browser and returns to the desktop app after authorization.
3. Choose a microphone and system output device, or keep the defaults.
4. Click **Start recording**.
5. Click **Stop and upload** when the meeting ends.

Desktop recordings use your Chronote account and do not require a Discord voice channel. Keep the app open until the upload is received. Processing continues in Chronote after the upload completes.

## Context menu commands

Right-click a user in the voice channel to access:

- **Stop recording**: Ends the current meeting. For short auto-recorded meetings, this can cancel the recording instead of generating notes.
