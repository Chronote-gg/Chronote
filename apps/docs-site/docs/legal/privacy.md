---
title: Privacy Policy
slug: /legal/privacy
---

Last updated: August 26, 2026

This policy explains what Chronote records, what we store, who else processes it, and what you can do about it. It is written to be read by the people it affects, not only by lawyers.

Chronote is operated by BASIC BIT LLC ("we", "us"). If you add Chronote to a Discord server, the server's admins decide how it is used, and this policy describes what happens to the data either way.

## The short version

- Chronote records a voice channel only when someone starts a meeting, or in channels where an admin turned on auto-record. It does not listen when no meeting is running.
- While a meeting runs, Chronote captures the voice audio, the text chat in the meeting channel, and who was present.
- Recordings are transcribed and summarized using OpenAI. Your audio and text pass through their systems to produce the transcript and notes.
- Meeting records are visible to people in your Discord server, subject to the access rules below, and to anyone you deliberately share a public link with.
- You can archive a meeting so it drops out of your library views, and an authorized requester can ask us to delete Chronote's stored meeting record.

## What Chronote records, and when

Recording starts in one of two ways:

| Trigger                     | Who can start it                                                |
| --------------------------- | --------------------------------------------------------------- |
| The `/startmeeting` command | Any member of the server, unless your admins have restricted it |
| Auto-record                 | Automatically, in voice channels an admin has enabled           |

When a meeting is running, Chronote is visibly present in the voice channel and posts in the text channel, so members can see that a meeting is being recorded. Chronote does not record voice channels outside of a meeting.

During a meeting, Chronote captures:

- **Voice audio** from participants in the channel.
- **Text chat** posted in the meeting's text channel during the meeting.
- **Attendance**, meaning which Discord accounts were present.

## What we store

| Data                                                                                                                                                                                                                                                                                          | Where it lives                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Audio recordings and transcripts                                                                                                                                                                                                                                                              | Amazon S3, encrypted at rest                          |
| Notes, summaries, decisions, action items, and correction history, including correction instructions, versions, editor, timestamps, and correction identifiers                                                                                                                                | Amazon DynamoDB, encrypted at rest                    |
| The meeting's text chat log, including any attachment links posted during the meeting                                                                                                                                                                                                         | Amazon S3, as text and JSON                           |
| Attendance records                                                                                                                                                                                                                                                                            | DynamoDB, stored as Discord account IDs               |
| Ask conversations: your questions and Chronote's answers                                                                                                                                                                                                                                      | DynamoDB                                              |
| Personal uploads, including the original audio or video file you provided, its filename, size, title, and tags. Video is not discarded after the audio is extracted                                                                                                                           | Amazon S3, with the job record in DynamoDB            |
| Feedback you send us: the message, the email or Discord contact you give, the account and server it came from, and any screenshots you attach                                                                                                                                                 | DynamoDB, with attachments in Amazon S3               |
| Your Discord account identity (account ID, username, avatar, email) and the list of servers you belong to                                                                                                                                                                                     | DynamoDB, obtained when you sign in to the web portal |
| Your Discord sign-in session, which includes access and refresh tokens issued by Discord                                                                                                                                                                                                      | DynamoDB, for as long as the session lasts            |
| Server settings: context, approved dictionary terms and descriptions, approved observed misspellings, auto-record rules, and voice preferences                                                                                                                                                | DynamoDB                                              |
| Dictionary approval provenance: proposal source, model name, prompt template name and version, approver's Discord account ID and timestamp, and meeting or correction identifiers when applicable. This does not include the populated prompt, instruction, notes diff, or transcript excerpt | DynamoDB                                              |
| Pending dictionary-teaching drafts and correction excerpts. Each temporary record has its own 15-minute expiration beginning when that record is created                                                                                                                                      | DynamoDB                                              |
| Subscription and payment records (not card numbers)                                                                                                                                                                                                                                           | DynamoDB, alongside Stripe                            |
| Access logs and operational logs                                                                                                                                                                                                                                                              | DynamoDB and Amazon CloudWatch                        |
| Notion and MCP connection tokens, if you connect them                                                                                                                                                                                                                                         | DynamoDB, encrypted or hashed                         |

We do not receive or store your payment card details. Stripe handles card data directly.

## Who else processes your data

Chronote depends on the following providers. The table lists the categories each provider can receive for processing, observability, analytics, or an integration you choose.

| Provider            | What it handles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord             | The platform Chronote runs on, and how you sign in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Amazon Web Services | Hosting, storage, and logging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| OpenAI              | Transcribing audio, and generating notes, corrections, dictionary-entry proposals, answers to Ask questions, and optional images. Content sent for processing includes your audio, transcript text, the meeting chat log, existing notes and correction instructions when you request a correction, your Ask questions, dictionary-teaching instructions, and the context we attach to improve accuracy: server and channel names, the server description, attendee labels, role and event names, your dictionary terms, and any context you have written. If you explicitly teach from a correction, OpenAI also receives up to 2,000 characters of the notes diff and up to 2,000 characters from lexically matching transcript segments. Text-to-speech sends whatever you ask Chronote to say out loud, including in sessions that record nothing |
| Stripe              | Payments and subscription billing. Receives your Discord email address, account ID, and username so a subscription can be matched to the right person and server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Langfuse            | Engineering observability and prompt management for transcription, notes, and dictionary teaching. Traces can include transcript and notes content, dictionary-teaching instructions and bounded correction context, and can attach a compressed copy of meeting audio                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Notion              | Only if a user connects their Notion account, to export notes there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| PostHog             | Product analytics for the website and web portal, and for what you do with Chronote in Discord. See the analytics section below for what this covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## How long we keep things

We keep meetings until an authorized requester asks us to remove them. Plan limits control how far back the Ask feature searches, not how long we store your data, so a meeting recorded on the Free plan is retained the same way a Pro one is.

Archiving a meeting hides it from your library views. It does not erase the recording, transcript, or notes from storage. To request deletion, email us. For a server meeting, the server's admins authorize deletion; a participant can contact us directly and we will coordinate with them. The account owner authorizes deletion for a personal meeting.

Within 30 days after an authorized request, we delete Chronote's meeting record from DynamoDB and S3, including its audio or uploaded source file, transcript, notes, chat log, attendance, correction history, and meeting indexes. Self-service deletion is not available yet. This deadline does not promise deletion of access or operational logs that follow their separate retention below, data someone already copied or exported, or copies previously processed by another provider.

Server admins (members with the Discord **Manage Server** permission) can also turn off viewer access to transcripts or audio recordings. That is an access setting, not deletion: Chronote continues to store and process those artifacts, and access can be restored later. Chronote's automated notes generation and correction workflows can still use the stored transcript. The correction workflow does not return the transcript as an artifact, but its proposed notes change and diff can include details or wording from the transcript.

Server and application logs held in Amazon CloudWatch expire after 365 days. Access records stored in our database do not expire on their own and are kept until we remove them.

Chronote's pending correction-excerpt record becomes unusable 15 minutes after a notes correction is applied and is then eligible for DynamoDB's automatic deletion; physical deletion can occur later. If a member generates proposed dictionary entries, the correction-excerpt record remains available for revisions until its original expiration, and a separate proposal-draft record begins its own 15-minute timer when that record is created. Reading or editing either record does not extend its timer, and deleting the meeting does not accelerate either timer. These limits apply only to Chronote's temporary DynamoDB records. Copies processed by OpenAI or stored in Langfuse traces may remain longer. We do not promise that the 15-minute limits or a meeting-deletion request deletes those provider copies, and we do not currently promise another fixed deletion deadline for them.

The natural-language instruction a member submits in the teaching flow is not copied into Chronote's proposal-draft DynamoDB record, but it is sent to OpenAI and can appear in Langfuse traces as described above. Observed misspellings included in an approved entry are alternate forms shown during review and retained as audit context with that entry; they are not added to the transcription prompt. An approved dictionary entry is a separate server setting: deleting the meeting that informed it does not delete the entry, its observed forms, or its meeting- or correction-linked approval provenance. A member with the required dictionary permission can remove the entry or clear the dictionary. That deletes the entry, forms, and provenance from Chronote's DynamoDB records, but does not promise deletion of copies already processed by OpenAI or stored in Langfuse traces. A later AI-assisted approval replaces the entry's previous last-approval provenance; a manual `/dictionary` update leaves that provenance unchanged. Notes correction history remains with the meeting under the meeting retention described above.

## Analytics

We use PostHog to understand how people use Chronote, both on the website and in Discord, so we can see where the product is confusing and what people actually do with it. This is worth stating plainly, because it is more than counting page views:

- **Page views and clicks.** Which pages you visit and which elements you interact with, including the text and labels of what you clicked.
- **Session replay.** A reconstruction of your session, so we can watch how a page was actually used. In the web portal this can include meeting content shown on screen, such as notes and transcript text.
- **What you do in Discord.** Actions the bot takes on your behalf, such as starting and ending a meeting, changing a server setting, or asking a question. These record that the action happened and its shape, for example how long a meeting ran or how many people attended. They never carry the content: not notes, not transcripts, not the text of your questions, dictionary terms, or context prompts.
- **Dictionary teaching.** PostHog usage analytics record that a proposal was previewed or approved, its server and acting account, whether it came from Server Settings or a notes correction, input length, proposal and conflict counts, saved and failed counts, and how many approved drafts were edited. They do not include the instruction, proposed or approved terms, descriptions, correction text, notes, or transcript content. Separate engineering traces in Langfuse can include content as described in the provider table above.
- **Technical metadata.** Your browser and device type, the page you came from, and the page you are on.

While you are signed in, these events are tied to your Discord account rather than to an anonymous browser identifier, so that your activity on the website and in Discord is understood as one person rather than two strangers. Signing out unlinks the browser from your account again.

Two things are deliberately excluded: share link ids are stripped before anything is sent, because those act as passwords for a shared meeting, and your IP address is discarded on arrival, so we do not derive a location from it.

**Turning it off.** These are two separate things, and it is worth being clear about which is which.

- **On the website and web portal**, enable Do Not Track in your browser and Chronote sends nothing to PostHog.
- **In Discord**, Do Not Track does not apply. It is a browser signal, and the bot never sees your browser, so actions you take through Chronote in Discord are recorded whether or not you have it enabled, including if you have never opened the portal.

To opt out of both, email us and we will exclude your account. We do not yet have a self-service switch for the Discord side.

## Who can see a meeting

- **Server meetings** are visible through the web portal only after Chronote checks the viewer's current Discord access to the meeting's voice and notes channels, or an attendee exception enabled by the server. Server membership alone does not grant access to every meeting.
- **Transcript and audio access** can be disabled independently by a server admin for all past and future server meetings. A meeting's summary and notes can remain visible while one or both source artifacts are unavailable.
- **Personal meetings**, including uploads, are visible only to the account that owns them, plus anyone that account grants access to.
- **Shared links** can be forwarded by anyone who receives them. A link set to "server" requires the viewer to sign in, belong to that server, and have access to the meeting's voice channel. A link set to "public" can be opened by anyone who has the URL, so treat it as published. Turning sharing off blocks future access through the link, but cannot recall content someone already copied or downloaded.

## Your choices

- **See your data.** Sign in to the web portal to read any meeting you have access to.
- **Take it with you.** Export the meeting data available to you from the portal. A server admin may make audio recordings or transcripts unavailable for server meetings.
- **Archive it.** Archive any meeting you own so it drops out of your library views, and unarchive it later if you change your mind.
- **Have it removed.** Email us to request deletion of Chronote's stored meeting record. Server admins authorize deletion for server meetings; personal meeting owners authorize their own meetings. The scope and provider limitations are described under [How long we keep things](#how-long-we-keep-things).
- **Turn recording off.** Server admins can disable auto-record per channel or entirely, and can remove Chronote from the server at any time, which stops all recording.
- **Limit artifact access.** Server admins with **Manage Server** can block future retrieval of transcripts, audio recordings, or both while leaving summaries and notes available. This does not delete the artifacts, recall existing copies, or stop the automated notes workflows described above. An issued audio URL remains usable for up to 15 minutes, and an already-open live transcript stream stays connected until the meeting ends or the viewer disconnects.
- **Correct the record.** Notes can be corrected through the correction and approval flow, so the stored record reflects what actually happened.
- **Control learned vocabulary.** Members with **Manage Server** can submit natural-language teaching instructions, generate AI proposals, inspect and edit the displayed entries, choose which entries are included, and approve the selected entries together as a batch. Members with **Manage Channels** can directly add, update, remove, or clear entries in the same server dictionary through `/dictionary`, without the AI proposal flow. Applying a notes correction alone does not change the dictionary.
- **Opt out of analytics.** Turn on Do Not Track in your browser and the website and portal will not send analytics events. Do Not Track cannot cover what you do in Discord, because the bot never sees your browser, so email us to opt out of that as well.
- **Ask us.** Email [basic@basicbit.net](mailto:basic@basicbit.net) with a data access or deletion request. We respond within 30 days.

### If you have data protection rights

If you are in the UK, the EU, California, or another region with specific data protection rights, those rights apply and the same address handles the request.

Which of us is answerable depends on the data:

- **For your account**, meaning your Discord identity, your sign-in session, billing records, and analytics, BASIC BIT LLC decides how that data is used and is the controller.
- **For meeting content recorded in a Discord server**, meaning recordings, transcripts, notes, and chat logs, the server that installed Chronote decides what gets recorded and why. That server's admins are the controller and Chronote acts as their processor. If you are a member of a server and want a recording of you removed, ask that server's admins first. You can also come to us and we will act on their instruction.
- **For personal meetings**, meaning uploads and recordings that belong to your account rather than to a server, there is no server admin in the middle. You decide what to upload, and BASIC BIT LLC is the controller. Contact us directly for those.

## Security

Data is encrypted in transit and at rest, using a KMS key we create and control rather than a default AWS-managed one, with automatic key rotation enabled. Access is restricted to the systems that need it, and access is logged. No system is perfectly secure, and we will tell affected users if we become aware of a breach affecting their data.

## Age

Chronote is used through Discord, which requires users to be at least 13 years old, or older where local law requires it. We do not knowingly collect data from anyone below that age.

## Changes to this policy

If we change this policy in a way that materially affects what happens to your data, we will note it on this page and in the [What's New](/whats-new/) feed before it takes effect.

## Contact

Questions, requests, or complaints: [basic@basicbit.net](mailto:basic@basicbit.net).
