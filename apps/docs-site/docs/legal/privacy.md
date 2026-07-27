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

| Data                                                                                               | Where it lives                                        |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Audio recordings and transcripts                                                                   | Amazon S3, encrypted at rest                          |
| Notes, summaries, decisions, action items, correction history                                      | Amazon DynamoDB, encrypted at rest                    |
| Attendance records                                                                                 | DynamoDB, stored as Discord account IDs               |
| Your Discord account identity (account ID, username, avatar) and the list of servers you belong to | DynamoDB, obtained when you sign in to the web portal |
| Server settings: context, dictionary terms, auto-record rules, voice preferences                   | DynamoDB                                              |
| Subscription and payment records (not card numbers)                                                | DynamoDB, alongside Stripe                            |
| Access logs and operational logs                                                                   | DynamoDB and Amazon CloudWatch                        |
| Notion and MCP connection tokens, if you connect them                                              | DynamoDB, encrypted or hashed                         |

We do not receive or store your payment card details. Stripe handles card data directly.

## Who else processes your data

Chronote depends on the following providers. Each one sees only what it needs to do its job.

| Provider            | What it handles                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Discord             | The platform Chronote runs on, and how you sign in                                                                                                                                         |
| Amazon Web Services | Hosting, storage, and logging                                                                                                                                                              |
| OpenAI              | Transcribing audio, and generating notes, corrections, and optional images. Content sent for processing includes your audio and transcript text                                            |
| Stripe              | Payments and subscription billing                                                                                                                                                          |
| Langfuse            | Engineering observability for the transcription and notes pipeline. Traces can include transcript and notes content                                                                        |
| Notion              | Only if a user connects their Notion account, to export notes there                                                                                                                        |
| PostHog             | Product analytics for the website and web portal: page views and clicks on things like the pricing buttons. Share link ids are removed before anything is sent, and we honour Do Not Track |

## How long we keep things

Retention depends on the plan the server is on, and is described on the [pricing section of our site](https://chronote.gg). Paid plans keep meeting history longer, and the Pro plan keeps it without a time limit.

Archiving a meeting hides it from your library views. It does not erase the recording, transcript, or notes from storage. If you want a meeting removed entirely, email us and we will do it. [TODO: confirm the removal turnaround and whether a self-service delete is planned before publishing.]

Operational logs are retained for up to 365 days.

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
- **Opt out of analytics.** Turn on Do Not Track in your browser and the site will not send analytics events.
- **Ask us.** Email [basic@basicbit.net](mailto:basic@basicbit.net) with a data access or deletion request and we will action it. [TODO: confirm the response window you want to commit to, for example 30 days.]

If you are in a region with specific data protection rights, such as the UK, EU, or California, those rights apply and the same contact address handles those requests. [TODO: legal review needed on controller versus processor roles and the exact statutory language.]

## Security

Data is encrypted in transit and at rest. Storage uses AWS-managed keys, access is restricted to the systems that need it, and access is logged. No system is perfectly secure, and we will tell affected users if we become aware of a breach affecting their data.

## Age

Chronote is used through Discord, which requires users to be at least 13 years old, or older where local law requires it. We do not knowingly collect data from anyone below that age.

## Changes to this policy

If we change this policy in a way that materially affects what happens to your data, we will note it on this page and in the [What's New](/whats-new/) feed before it takes effect.

## Contact

Questions, requests, or complaints: [basic@basicbit.net](mailto:basic@basicbit.net).
