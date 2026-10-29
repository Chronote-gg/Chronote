---
title: Getting Started
slug: /getting-started
---

This guide walks you through adding Chronote to your Discord server and running your first recorded meeting.

## Prerequisites

- A Discord server where you have **Manage Server** permission.
- At least one voice channel and one text channel.
- Chronote added to the server. The Free plan can record your first meeting.

## Step 1: Add Chronote to your server

Use the invite link from [chronote.gg](https://chronote.gg) to add the bot. Discord will prompt you to select a server and confirm permissions. Chronote needs:

- **View Channels**, **Send Messages**, and **Read Message History** in text channels where it will post notes.
- **Connect** and **Speak** in voice channels it will record.

After the bot joins, it sends the installer (or server owner) a DM with the recording steps. **Open portal** opens Meetings with that server selected, and the server-named button opens Discord. If the DM is blocked, the empty server source has the same instructions.

After authorization, the first-recording guide offers **Open Discord** and an example of the notes. Use the server where you added Chronote. You do not need to sign into the web portal to start a recording.

## Step 2: Record your first meeting

1. Join a voice channel.
2. Run `/startmeeting` in a text channel.
3. Follow Chronote's private link to your recording, then press **End meeting** when you're done.

You can also start from **Apps** -> **Start meeting** on yourself, Chronote, or another person in your voice channel. The slash command accepts optional `context`, `tags` and `notes-channel` values. None is required for your first recording.

Chronote joins the voice channel and begins recording. The private **View recording** link opens the published recording message with its **End Meeting** button, including when it is in the same channel where you ran the command.

Controls and notes go to your one-meeting choice, then the voice-channel override, then the server default. If none is configured, they go to the text channel where you ran the command. A deleted or inaccessible destination blocks the start without fallback. Changing a default during recording affects the next meeting.

## Find your notes

End the meeting in any of these ways:

- Click the **End Meeting** button on the embed.
- Right-click Chronote in the voice channel and select **Disconnect**.
- Leave the voice channel (the meeting ends when no participants remain).

Chronote processes the recording:

1. Audio is transcribed per speaker.
2. Notes are generated from the transcript, context, and dictionary.
3. A summary embed and full notes are posted to the same destination as the recording controls.
4. Everything is saved to your meeting history.

## What to set up next

Open **Meetings** in the portal to browse recordings you can access across servers and personal recordings. It starts with all sources, all time and active meetings. Choose a server or **Personal recordings** in the source list. On mobile, the sources appear above the list, and **Filters** opens the date, archive, tag and channel controls. Personal recordings includes recordings shared with you.

Check **Only meetings I attended** to show conversations you participated in. Creating a recording or receiving a shared recording does not count as attendance. Use **Load more** for older results. **Search loaded meetings** searches the recordings already loaded, and the count describes those loaded results.

Open a meeting to read its notes and transcript, then close it to return to your filters. Old server Library links and direct meeting links still open the matching destination. Uploads, personal settings, Ask, billing and server settings remain available with their existing permissions.

Optional setup can wait until after your first recording. Expand **Optional setup** on the guide for `/context` and `/autorecord`, or use Server Settings to choose a default notes channel. Existing command and settings permissions still apply. `/onboard` has been retired; old wizard controls link to the portal without changing settings.

Use **Open meeting** on the Discord notes or the website guide to open that saved meeting. **Open portal** opens Meetings with that server selected before or after recording. The portal asks you to sign in with Discord if needed and returns to the intended destination.

The guide distinguishes recording, preparing notes and saved notes. A partial or failed Discord delivery still offers the saved meeting, with a notice to check Chronote's notes-channel permissions. Interrupted recordings keep their coverage warnings.

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
