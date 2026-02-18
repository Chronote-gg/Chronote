---
title: Getting Started
slug: /getting-started
---

This guide walks you through adding Chronote to your Discord server and running your first recorded meeting.

## Prerequisites

- A Discord server where you have **Manage Server** permission.
- At least one voice channel and one text channel.
- A Chronote subscription (free tier available).

## Step 1: Add Chronote to your server

Use the invite link from [chronote.gg](https://chronote.gg) to add the bot. Discord will prompt you to select a server and confirm permissions. Chronote needs:

- **View Channels** and **Send Messages** in text channels where it will post notes.
- **Connect** and **Speak** in voice channels it will record.

After the bot joins, it sends a DM to the installer (or server owner) with a link to the onboarding wizard.

## Step 2: Run the onboarding wizard

Type `/onboard` in any text channel. The wizard walks you through:

- Selecting a default notes channel (where meeting summaries are posted).
- Setting initial server context (a short description of your team or project).
- Adding dictionary terms for names, acronyms, or jargon your team uses.

The onboarding wizard requires **Manage Server** permission. You can skip it and configure these settings individually later.

## Step 3: Start your first meeting

1. Join a voice channel.
2. Run `/startmeeting` in a text channel.
3. Optionally add a `context` parameter (e.g., "Weekly standup for backend team") and `tags` (e.g., "standup, backend").

Chronote joins the voice channel and begins recording. You will see a "Meeting Started" embed with an **End Meeting** button.

## Step 4: End the meeting

End the meeting in any of these ways:

- Click the **End Meeting** button on the embed.
- Right-click Chronote in the voice channel and select **Disconnect**.
- Leave the voice channel (the meeting ends when no participants remain).

Chronote processes the recording:

1. Audio is transcribed per speaker.
2. Notes are generated from the transcript, context, and dictionary.
3. A summary embed and full notes are posted to the text channel.
4. Everything is saved to your meeting history.

## What to set up next

| Task                       | Command                 | Details                                 |
| -------------------------- | ----------------------- | --------------------------------------- |
| Add domain terms           | `/dictionary add`       | [Features](/features/)                  |
| Set server/channel context | `/context set-server`   | [Admin Guide](/admin/setup-and-access/) |
| Enable auto-recording      | `/autorecord enable`    | [Admin Guide](/admin/setup-and-access/) |
| Explore the web portal     | Link in meeting summary | Browse past meetings and share notes    |

## Permissions summary

| Permission      | Where          | Why                                                   |
| --------------- | -------------- | ----------------------------------------------------- |
| View Channel    | Text channels  | Read messages and post notes                          |
| Send Messages   | Text channels  | Post meeting embeds and notes                         |
| Connect         | Voice channels | Join and record audio                                 |
| Speak           | Voice channels | Required by Discord for voice bots                    |
| Manage Channels | Server-wide    | Required for `/autorecord`, `/context`, `/dictionary` |
