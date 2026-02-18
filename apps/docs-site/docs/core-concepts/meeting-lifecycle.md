---
title: Meeting Lifecycle
slug: /core-concepts/meeting-lifecycle
---

Every Chronote recording follows a predictable lifecycle. Understanding these stages helps you get better notes and troubleshoot issues when they arise.

## Stage 1: Start

A meeting starts in one of two ways:

- **Manual**: A user runs `/startmeeting` while in a voice channel. They can optionally provide a `context` description and `tags`.
- **Auto-record**: A user joins a voice channel that has auto-recording enabled. Chronote starts recording automatically and posts an "Auto-Recording Started" embed.

At this point, Chronote joins the voice channel and begins capturing audio from each participant separately. A meeting embed appears in the text channel with controls.

**Constraints**: Only one meeting can be active per server at a time. The user who starts the meeting must be in a voice channel. The server must have available meeting minutes on its plan.

## Stage 2: Capture

While the meeting is active, Chronote captures three streams of data:

- **Voice audio** from each participant as individual audio snippets. Audio is processed through a noise gate that filters silence and very quiet segments.
- **Chat messages** from the text channel, including any images shared (which are later captioned by AI).
- **Attendance** tracking who joins and leaves the voice channel.

During capture, the meeting embed stays pinned with buttons for **End Meeting**, **Edit Tags**, and a link to the **Live Transcript** on the web portal (if configured).

## Stage 3: Process

Processing begins when the meeting ends. The embed updates to show "processing" status. This stage involves several steps:

1. **Transcription**: Each audio snippet is sent to OpenAI's transcription model with a prompt that includes your dictionary terms and context. Quality checks filter out noise, prompt echoes, and low-confidence segments.
2. **Transcript cleanup**: A language model pass cleans up the raw transcription for readability.
3. **Notes generation**: The full transcript, chat log, participant roster, server/channel/meeting context, dictionary entries (with definitions), and recent meeting history are sent to a language model that produces structured meeting notes.
4. **Artifact upload**: The audio recording, transcript, and chat log are uploaded to cloud storage.

The processing step typically takes 1-3 minutes depending on meeting length.

## Stage 4: Publish

Once processing completes, Chronote posts results to Discord:

- A **Meeting Summary** embed with: meeting name, one-sentence summary, start/end times, duration, attendees, voice channel, and tags.
- One or more **Meeting Notes** embeds containing the full generated notes (paginated if long).
- Action buttons: **Open in Chronote** (web portal link), **Helpful** / **Needs work** (feedback), **Suggest correction**, **Rename meeting**, **Edit Tags**.

The meeting is also saved to your meeting history in the database, accessible through the web portal and the `/ask` command.

## Stage 5: Revise

After publishing, authorized users can refine the notes:

1. Click **Suggest correction** on the meeting summary.
2. Describe what should change in the modal (up to 1500 characters).
3. Chronote generates a minimal correction using the transcript as ground truth and shows a line diff.
4. An authorized user (meeting creator, or anyone with Manage Channels for auto-recorded meetings) reviews and clicks **Accept & update** or **Reject**.

Accepted corrections update the notes in place, increment the version number, and record the edit in the suggestion history. Each correction builds on the previous version, so the AI has full context of past edits.

## Auto-record cancellation

If an auto-recorded meeting produces too little content (e.g., someone briefly joins then leaves), Chronote cancels the meeting instead of generating notes. The start embed is replaced with an "Auto-Recording Cancelled" message showing the reason.

## Meeting duration limit

Meetings are capped at 2 hours. If the limit is reached, the meeting ends automatically and processing begins.

## Weekly minutes limit

Each subscription tier includes a weekly meeting minutes allowance. If the limit is reached, new meetings cannot start until the next billing cycle. A warning is posted when the server approaches or hits the limit.

## Context and quality factors

Several factors influence the quality of transcription and notes:

| Factor           | How to configure                | Effect                                                 |
| ---------------- | ------------------------------- | ------------------------------------------------------ |
| Server context   | `/context set-server`           | Helps the AI understand your team, project, and domain |
| Channel context  | `/context set-channel`          | Adds channel-specific context (e.g., "design reviews") |
| Meeting context  | `/startmeeting context:` option | Describes this specific meeting's topic                |
| Dictionary terms | `/dictionary add`               | Corrects spelling of names, acronyms, jargon           |
| Audio quality    | Participant microphone settings | Clearer audio produces more accurate transcription     |
| Speaking volume  | Participant microphone levels   | Very quiet audio may be filtered by the noise gate     |
