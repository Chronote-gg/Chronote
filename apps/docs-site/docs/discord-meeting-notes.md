---
title: Discord Meeting Notes
slug: /discord-meeting-notes
description: Record Discord voice calls, create structured meeting notes, and retrieve past decisions with Chronote.
---

Chronote records a Discord voice call, writes the meeting notes, and posts them back to the channel, all without asking anyone to leave Discord. It transcribes each speaker separately and keeps the meeting available for later questions and corrections.

## When Chronote fits

Chronote is useful when important decisions happen in voice and the people involved need more than a raw recording afterward. Common examples include:

- Community planning calls and moderator meetings.
- Project standups, retrospectives, and design reviews.
- Study groups and tutoring sessions.
- Game, event, and campaign planning.
- Any recurring Discord call where decisions or assignments otherwise live only in someone's memory.

One install covers the whole server, and notes land in the channel where the group already talks.

## What happens in a meeting

1. **Start recording.** Join a voice channel and run `/startmeeting`, use the Start meeting app action, or let an administrator configure auto-recording for selected channels.
2. **Keep talking normally.** Chronote records the voice channel, captures meeting-channel chat and attendance, and transcribes each speaker separately.
3. **End the meeting.** Use the End Meeting button, disconnect Chronote, or leave the voice channel. Auto-recorded meetings also end when the channel empties.
4. **Read the result in Discord.** Chronote posts a summary, decisions, open questions, and next steps back to the notes channel.
5. **Find it later.** The web portal stores the meeting record, and `/ask` answers questions about recent meetings, citing the source meeting and timestamp.

See [Meeting Lifecycle](/core-concepts/meeting-lifecycle/) for the complete recording and processing flow.

## More than transcription

A transcript preserves what was said; useful meeting notes make that conversation easier to act on. Chronote can:

- Highlight decisions, unresolved questions, and next steps.
- Assign action items using valid Discord member or role mentions.
- Use server context and a managed dictionary for project names and specialized terms.
- Include text chat and attendance alongside the spoken conversation.
- Let attendees suggest corrections, with an authorized person approving the change.
- Provide audio and transcript downloads from the portal, and export current notes to Notion.
- Auto-record only the channels an administrator chooses.

The [Features reference](/features/) lists the current commands, permissions, and output for each capability.

## Recording visibility and access

Chronote only records while a meeting is running. It appears in the voice channel and posts a meeting status message so participants can see that recording is active. Administrators decide whether to enable auto-recording and can independently control viewer access to stored transcripts and audio.

Meeting content is not part of Chronote's public website. Access through Discord, the portal, shared links, and Remote MCP follows the documented permission rules. Read the [Privacy Policy](/legal/privacy/) for the data collected during a meeting, storage, service providers, and deletion requests.

## Try a first meeting

Chronote has a free server plan. To test the workflow:

1. [Add Chronote to your Discord server](https://chronote.gg/).
2. Complete the short [Getting Started](/getting-started/) setup.
3. Run one real voice meeting and review the notes with the participants.

That first completed meeting is the best test: it shows whether the transcript recognizes your terminology, whether the note structure fits the group, and which context or dictionary entries would improve the next result.
