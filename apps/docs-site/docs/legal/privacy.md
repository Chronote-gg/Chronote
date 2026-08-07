---
title: Privacy Policy
slug: /legal/privacy
---

Last updated: July 27, 2026

This policy explains what Chronote records, what we store, who else processes it, and what you can do about it. It is written to be read by the people it affects, not only by lawyers.

Chronote is operated by BASIC BIT LLC ("we", "us"). If you add Chronote to a Discord server, the server's admins decide how it is used, and this policy describes what happens to the data either way.

## The short version

- Chronote records a voice channel only when someone starts a meeting, or in channels where an admin turned on auto-record. It does not listen when no meeting is running.
- While a meeting runs, Chronote captures the voice audio, the text chat in the meeting channel, and who was present.
- Recordings are transcribed and summarized using OpenAI. Your audio and text pass through their systems to produce the transcript and notes.
- Meeting records are visible to people in your Discord server, subject to the access rules below, and to anyone you deliberately share a public link with.
- You can archive a meeting so it drops out of your library views, and you can ask us to remove one entirely.

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

| Data                                                                                                                                                                | Where it lives                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Audio recordings and transcripts                                                                                                                                    | Amazon S3, encrypted at rest                          |
| Notes, summaries, decisions, action items, correction history                                                                                                       | Amazon DynamoDB, encrypted at rest                    |
| The meeting's text chat log, including any attachment links posted during the meeting                                                                               | Amazon S3, as text and JSON                           |
| Attendance records                                                                                                                                                  | DynamoDB, stored as Discord account IDs               |
| Ask conversations: your questions and Chronote's answers                                                                                                            | DynamoDB                                              |
| Personal uploads, including the original audio or video file you provided, its filename, size, title, and tags. Video is not discarded after the audio is extracted | Amazon S3, with the job record in DynamoDB            |
| Feedback you send us: the message, the email or Discord contact you give, the account and server it came from, and any screenshots you attach                       | DynamoDB, with attachments in Amazon S3               |
| Your Discord account identity (account ID, username, avatar, email) and the list of servers you belong to                                                           | DynamoDB, obtained when you sign in to the web portal |
| Your Discord sign-in session, which includes access and refresh tokens issued by Discord                                                                            | DynamoDB, for as long as the session lasts            |
| Server settings: context, dictionary terms, auto-record rules, voice preferences                                                                                    | DynamoDB                                              |
| Subscription and payment records (not card numbers)                                                                                                                 | DynamoDB, alongside Stripe                            |
| Access logs and operational logs                                                                                                                                    | DynamoDB and Amazon CloudWatch                        |
| Notion and MCP connection tokens, if you connect them                                                                                                               | DynamoDB, encrypted or hashed                         |

We do not receive or store your payment card details. Stripe handles card data directly.

## Who else processes your data

Chronote depends on the following providers. Each one sees only what it needs to do its job.

| Provider            | What it handles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discord             | The platform Chronote runs on, and how you sign in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Amazon Web Services | Hosting, storage, and logging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| OpenAI              | Transcribing audio, and generating notes, corrections, answers to Ask questions, and optional images. Content sent for processing includes your audio, transcript text, the meeting chat log, your Ask questions, and the context we attach to improve accuracy: server and channel names, the server description, attendee labels, role and event names, your dictionary terms, and any context you have written. Text-to-speech also sends whatever you ask Chronote to say out loud, including in sessions that record nothing |
| Stripe              | Payments and subscription billing. Receives your Discord email address, account ID, and username so a subscription can be matched to the right person and server                                                                                                                                                                                                                                                                                                                                                                  |
| Langfuse            | Engineering observability for the transcription and notes pipeline. Traces can include transcript and notes content, and attach a compressed copy of the meeting audio                                                                                                                                                                                                                                                                                                                                                            |
| Notion              | Only if a user connects their Notion account, to export notes there                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PostHog             | Product analytics for the website and web portal. See the analytics section below for what this covers                                                                                                                                                                                                                                                                                                                                                                                                                            |

## How long we keep things

We keep meetings until you ask us to remove them. Plan limits control how far back the Ask feature searches, not how long we store your data, so a meeting recorded on the Free plan is retained the same way a Pro one is.

Archiving a meeting hides it from your library views. It does not erase the recording, transcript, or notes from storage. If you want a meeting removed entirely, email us and we will remove it, including the audio and transcript, within 30 days. Self-service deletion is not available yet.

Server and application logs held in Amazon CloudWatch expire after 365 days. Access records stored in our database do not expire on their own and are kept until we remove them.

## Analytics

We use PostHog to understand how people use Chronote, both on the website and in Discord, so we can see where the product is confusing and what people actually do with it. This is worth stating plainly, because it is more than counting page views:

- **Page views and clicks.** Which pages you visit and which elements you interact with, including the text and labels of what you clicked.
- **Session replay.** A reconstruction of your session, so we can watch how a page was actually used. In the web portal this can include meeting content shown on screen, such as notes and transcript text.
- **What you do in Discord.** Actions the bot takes on your behalf, such as starting and ending a meeting, changing a server setting, or asking a question. These record that the action happened and its shape, for example how long a meeting ran or how many people attended. They never carry the content: not notes, not transcripts, not the text of your questions, dictionary terms, or context prompts.
- **Technical metadata.** Your browser and device type, the page you came from, and the page you are on.

While you are signed in, these events are tied to your Discord account rather than to an anonymous browser identifier, so that your activity on the website and in Discord is understood as one person rather than two strangers. Signing out unlinks the browser from your account again.

Two things are deliberately excluded: share link ids are stripped before anything is sent, because those act as passwords for a shared meeting, and your IP address is discarded on arrival, so we do not derive a location from it.

**Turning it off.** These are two separate things, and it is worth being clear about which is which.

- **On the website and web portal**, enable Do Not Track in your browser and Chronote sends nothing to PostHog.
- **In Discord**, Do Not Track does not apply. It is a browser signal, and the bot never sees your browser, so actions you take through Chronote in Discord are recorded whether or not you have it enabled, including if you have never opened the portal.

To opt out of both, email us and we will exclude your account. We do not yet have a self-service switch for the Discord side.

## Who can see a meeting

- **Server meetings** are visible to members of that Discord server through the web portal, subject to the server's access rules.
- **Personal meetings**, including uploads, are visible only to the account that owns them, plus anyone that account grants access to.
- **Shared links** are visible to whoever you give them to. A link set to "server" requires the viewer to sign in and belong to that server. A link set to "public" can be opened by anyone who has the URL, so treat it as published. You can turn sharing off again at any time.

## Your choices

- **See your data.** Sign in to the web portal to read any meeting you have access to.
- **Take it with you.** Export audio, transcripts, and notes from the portal.
- **Archive it.** Archive any meeting you own so it drops out of your library views, and unarchive it later if you change your mind.
- **Have it removed.** Email us to have a meeting and its recording removed from storage entirely.
- **Turn recording off.** Server admins can disable auto-record per channel or entirely, and can remove Chronote from the server at any time, which stops all recording.
- **Correct the record.** Notes can be corrected through the correction and approval flow, so the stored record reflects what actually happened.
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
