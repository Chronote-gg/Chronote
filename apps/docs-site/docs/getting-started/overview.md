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

- **View Channels**, **Send Messages**, and **Read Message History** in text channels where it will post notes.
- **Connect** and **Speak** in voice channels it will record.

After the bot joins, it sends a DM to the installer (or server owner) with a link to the onboarding wizard.

After authorization, the first-recording guide offers **Open Discord** and an example of the notes. Use the server where you added Chronote. You do not need to sign into the web portal to start a recording.

## Step 2: Start your first meeting

1. Join a voice channel.
2. Tell participants you are recording. Run `/startmeeting` in a text channel, or right-click yourself, Chronote, or someone in your voice channel and select **Apps** -> **Start meeting**.
3. If you use `/startmeeting`, optionally add a `context` parameter (e.g., "Weekly standup for backend team") and `tags` (e.g., "standup, backend").

Chronote joins the voice channel and begins recording. You will see a "Meeting Started" embed with an **End Meeting** button.

## Step 3: End the meeting

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

Optional setup can wait until after your first recording. Type `/onboard` to choose a default notes channel and set initial server context. The wizard requires **Manage Server** permission; you can also configure those settings individually.

Open the meeting library from the guide or a meeting summary to browse your notes and transcripts. The portal asks you to sign in with Discord if needed.

| Task                         | Command                              | Details                                 |
| ---------------------------- | ------------------------------------ | --------------------------------------- |
| Teach names and domain terms | Server Settings or `/dictionary add` | [Features](/features/)                  |
| Set server/channel context   | `/context set-server`                | [Admin Guide](/admin/setup-and-access/) |
| Enable auto-recording        | `/autorecord enable`                 | [Admin Guide](/admin/setup-and-access/) |
| Explore the web portal       | Link in meeting summary              | Browse past meetings and share notes    |

## Permissions summary

| Permission           | Where          | Why                                                   |
| -------------------- | -------------- | ----------------------------------------------------- |
| View Channel         | Text channels  | Access notes channels                                 |
| Send Messages        | Text channels  | Post meeting embeds and notes                         |
| Read Message History | Text channels  | Update meeting status and summary messages            |
| Connect              | Voice channels | Join and record audio                                 |
| Speak                | Voice channels | Required by Discord for voice bots                    |
| Manage Channels      | Server-wide    | Required for `/autorecord`, `/context`, `/dictionary` |
